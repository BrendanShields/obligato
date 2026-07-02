import ts from "typescript";

// DSL-3 scope rule, as pinned by divergence testing: free identifiers
// (including globals) are rejected by name; a chain rooted at the context
// parameter must reach an input name or a declared observe path — stopping at
// a proper prefix of a declared path is rejected, going deeper than a declared
// leaf is allowed. `when`/`expect` are the closed compiler-provided context
// API, not declarations. Locals and shadowed inner params are exempt.
const CONTEXT_HELPERS = ["when", "expect"];

export interface PredicateDeclarations {
  inputs: readonly string[];
  observe: readonly string[];
}

const bindingNames = (name: ts.BindingName, into: Set<string>): void => {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const el of name.elements)
      if (!ts.isOmittedExpression(el)) bindingNames(el.name, into);
};

const isReferencePosition = (id: ts.Identifier): boolean => {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p)) &&
    p.name === id
  )
    return false;
  if (ts.isTypeReferenceNode(p) || ts.isTypeNode(p)) return false;
  return true;
};

const accessPath = (id: ts.Identifier): string[] => {
  const path: string[] = [];
  let node: ts.Expression = id;
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node
  ) {
    path.push(node.parent.name.text);
    node = node.parent;
  }
  return path;
};

export const analyzeCheck = (
  source: string,
  decl: PredicateDeclarations,
): string[] => {
  const sf = ts.createSourceFile(
    "check.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  let fn: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const findFn = (node: ts.Node): void => {
    if (fn) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      fn = node;
      return;
    }
    ts.forEachChild(node, findFn);
  };
  findFn(sf);
  if (!fn) return ["check must be a single arrow function"];
  const param = fn.parameters[0];
  if (!param || !ts.isIdentifier(param.name))
    return ["check's context parameter must be a plain identifier"];
  const ctxName = param.name.text;

  const errors: string[] = [];
  const observeSplit = decl.observe.map((p) => p.split("."));

  const checkContextChain = (id: ts.Identifier): void => {
    const path = accessPath(id);
    if (path.length === 0) {
      errors.push(
        `check references the entire context "${ctxName}" — access a declared input or observable`,
      );
      return;
    }
    if (CONTEXT_HELPERS.includes(path[0] as string)) return;
    if (decl.inputs.includes(path[0] as string)) return;
    const properPrefixOf = observeSplit.some(
      (obs) =>
        path.length < obs.length && path.every((seg, i) => seg === obs[i]),
    );
    const reachesDeclared = observeSplit.some(
      (obs) =>
        obs.length <= path.length && obs.every((seg, i) => seg === path[i]),
    );
    if (reachesDeclared) return;
    const accessed = path.join(".");
    errors.push(
      properPrefixOf
        ? `check references "${accessed}", which is only a prefix of a declared observable — access a full declared path`
        : `check references undeclared name "${accessed}" (declared inputs: ${decl.inputs.join(", ") || "<none>"}; observables: ${decl.observe.join(", ") || "<none>"}; helpers: ${CONTEXT_HELPERS.join(", ")})`,
    );
  };

  // Scope stack: index 0 is the predicate's own parameter scope; a name found
  // only there is a context reference, anywhere deeper is a local.
  const rootScope = new Set<string>();
  for (const p of fn.parameters) bindingNames(p.name, rootScope);
  const scopes: Set<string>[] = [rootScope];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node !== fn
    ) {
      const scope = new Set<string>();
      for (const p of node.parameters) bindingNames(p.name, scope);
      scopes.push(scope);
      ts.forEachChild(node, visit);
      scopes.pop();
      return;
    }
    if (ts.isVariableDeclaration(node))
      bindingNames(node.name, scopes[scopes.length - 1] as Set<string>);
    if (ts.isFunctionDeclaration(node) && node.name)
      (scopes[scopes.length - 1] as Set<string>).add(node.name.text);
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const scope = new Set<string>();
      bindingNames(node.variableDeclaration.name, scope);
      scopes.push(scope);
      ts.forEachChild(node.block, visit);
      scopes.pop();
      return;
    }
    if (ts.isIdentifier(node) && isReferencePosition(node)) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if ((scopes[i] as Set<string>).has(node.text)) {
          if (i === 0 && node.text === ctxName) checkContextChain(node);
          return;
        }
      }
      errors.push(`check references undeclared name "${node.text}"`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return errors;
};

// biome-ignore lint/complexity/noBannedTypes: the compiled predicate is by nature untyped
export const compilePredicate = (source: string): Function => {
  const js = new Bun.Transpiler({ loader: "ts" })
    .transformSync(`const __predicate = ${source};`)
    .trim();
  return new Function(`${js} return __predicate;`)() as Function;
};

interface WhenChain {
  expect: (assertion: boolean) => boolean;
}

export const buildContext = (
  inputs: Record<string, unknown>,
  observed: Record<string, unknown>,
  observe: readonly string[],
): Record<string, unknown> => {
  const ctx: Record<string, unknown> = { ...inputs };
  for (const path of observe) {
    const segs = path.split(".");
    let src: unknown = observed;
    for (const s of segs)
      src =
        src !== null && typeof src === "object"
          ? (src as Record<string, unknown>)[s]
          : undefined;
    let target = ctx;
    for (const s of segs.slice(0, -1)) {
      if (typeof target[s] !== "object" || target[s] === null) target[s] = {};
      target = target[s] as Record<string, unknown>;
    }
    target[segs[segs.length - 1] as string] = src;
  }
  ctx.when = (cond: boolean): WhenChain => ({
    expect: (assertion: boolean) => (cond ? assertion : true),
  });
  ctx.expect = (assertion: boolean): boolean => assertion;
  return ctx;
};
