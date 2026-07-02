import {
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import {
  answerField,
  cancel,
  complete,
  createModel,
  type DispatchTable,
  type LauncherModel,
  selectSpec,
  WIZARDS,
  type WizardSpec,
} from "./wizards.js";

// UX-7 launcher: OpenTUI shell around the pure model in wizards.ts. The
// shell only feeds events; every dispatch goes through complete(), which
// uses the same table as typed commands (UX-8). buildLauncher constructs
// the render tree and is driven headlessly by the obligation test; runLauncher
// wraps it with the real renderer and process lifecycle.
export const buildLauncher = (
  renderer: CliRenderer,
  onFinish: (m: LauncherModel) => void,
): { menu: SelectRenderable } => {
  let model: LauncherModel = createModel();

  const title = new TextRenderable(renderer, {
    id: "title",
    content: "kelson — pick a command (esc to quit)",
    flexShrink: 0,
  });
  renderer.root.add(title);

  const menu = new SelectRenderable(renderer, {
    id: "menu",
    options: WIZARDS.map((w) => ({
      name: w.title,
      description: w.description,
      value: w,
    })),
    showDescription: true,
    // without a concrete height the select collapses to one clipped line in
    // the flex column (the bug that shipped a blank menu); fill the rest.
    flexGrow: 1,
  });
  renderer.root.add(menu);
  menu.focus();

  const askField = (spec: WizardSpec): void => {
    const field = spec.fields[model.fieldIndex];
    if (!field) return;
    const label = new TextRenderable(renderer, {
      id: `label-${model.fieldIndex}`,
      content: `${field.label}${field.required ? "" : " (optional)"}:`,
      flexShrink: 0,
    });
    const input = new InputRenderable(renderer, {
      id: `input-${model.fieldIndex}`,
      placeholder: field.label,
      flexShrink: 0,
    });
    renderer.root.add(label);
    renderer.root.add(input);
    input.focus();
    input.on(InputRenderableEvents.ENTER, () => {
      model = answerField(model, input.value);
      if (model.state === "done") onFinish(model);
      else if (model.fieldIndex < spec.fields.length) askField(spec);
    });
  };

  menu.on(
    SelectRenderableEvents.ITEM_SELECTED,
    (_i: number, opt: { value: WizardSpec }) => {
      model = selectSpec(model, opt.value);
      if (model.state === "done") onFinish(model);
      else {
        menu.blur();
        renderer.root.remove(menu.id);
        askField(opt.value);
      }
    },
  );

  renderer.keyInput.on("keypress", (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
      model = cancel(model);
      onFinish(model);
    }
  });

  return { menu };
};

export const runLauncher = async (table: DispatchTable): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const finish = async (m: LauncherModel): Promise<void> => {
    renderer.destroy();
    if (m.state === "done") await complete(m, table);
    process.exit(m.state === "cancelled" ? 0 : (process.exitCode ?? 0));
  };
  buildLauncher(renderer, (m) => void finish(m));
};
