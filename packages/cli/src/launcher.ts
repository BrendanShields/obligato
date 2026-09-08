import type { InboxItem } from "@obligato/schemas";
import {
  type CliRenderer,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { readInbox, resolveInboxDbPath } from "./commands/inbox.js";
import {
  answerField,
  cancel,
  complete,
  createModel,
  type DispatchTable,
  type LauncherModel,
  openMenu,
  selectItem,
  selectSpec,
  WIZARDS,
  type WizardSpec,
} from "./wizards.js";

// UX-43: the home rows — one per inbox item plus the menu escape hatch. The
// labels are the model's own summary/verb pair, so a snapshot reads exactly
// what the CLI table prints.
export const ALL_COMMANDS_ROW = "all commands…";

export const homeRows = (
  inbox: InboxItem[],
): { name: string; description: string; value: InboxItem | null }[] => [
  ...inbox.map((item) => ({
    name: item.summary,
    description: `→ ${item.verb}`,
    value: item,
  })),
  { name: ALL_COMMANDS_ROW, description: "the UX-7 command menu", value: null },
];

// UX-7 launcher: OpenTUI shell around the pure model in wizards.ts. The
// shell only feeds events; every dispatch goes through complete(), which
// uses the same table as typed commands (UX-8). buildLauncher constructs
// the render tree and is driven headlessly by the obligation test; runLauncher
// wraps it with the real renderer and process lifecycle. `inbox` is REQUIRED
// (UX-43): the home screen exists iff the caller read at least one item.
export const buildLauncher = (
  renderer: CliRenderer,
  onFinish: (m: LauncherModel) => void,
  inbox: InboxItem[],
): { menu: SelectRenderable } => {
  let model: LauncherModel = createModel(inbox);

  const title = new TextRenderable(renderer, {
    id: "title",
    content:
      model.state === "home"
        ? `obligato — ${inbox.length} item${inbox.length === 1 ? "" : "s"} need you (esc to quit)`
        : "obligato — pick a command (esc to quit)",
    flexShrink: 0,
  });
  renderer.root.add(title);

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

  // After a selection the list leaves the tree; fields (if any) take over.
  const afterSelect = (list: SelectRenderable, spec: WizardSpec): void => {
    if (model.state === "done") onFinish(model);
    else {
      list.blur();
      renderer.root.remove(list.id);
      askField(spec);
    }
  };

  const mountMenu = (): SelectRenderable => {
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
    menu.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_i: number, opt: { value: WizardSpec }) => {
        model = selectSpec(model, opt.value);
        afterSelect(menu, opt.value);
      },
    );
    return menu;
  };

  const mountHome = (): SelectRenderable => {
    const home = new SelectRenderable(renderer, {
      id: "home",
      options: homeRows(inbox),
      showDescription: true,
      flexGrow: 1,
    });
    renderer.root.add(home);
    home.focus();
    home.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_i: number, opt: { value: InboxItem | null }) => {
        if (opt.value === null) {
          model = openMenu(model);
          home.blur();
          renderer.root.remove(home.id);
          title.content = "obligato — pick a command (esc to quit)";
          mountMenu();
          return;
        }
        model = selectItem(model, opt.value);
        afterSelect(home, model.spec as WizardSpec);
      },
    );
    return home;
  };

  const menu = model.state === "home" ? mountHome() : mountMenu();

  renderer.keyInput.on("keypress", (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
      model = cancel(model);
      onFinish(model);
    }
  });

  return { menu };
};

export const runLauncher = async (table: DispatchTable): Promise<void> => {
  // UX-43: read the attention queue through the same path as `obligato
  // inbox` (UX-42) — a missing store is zero items, never an error.
  const inbox = readInbox(
    resolveInboxDbPath({}),
    new Date().toISOString(),
  ).items;
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const finish = async (m: LauncherModel): Promise<void> => {
    renderer.destroy();
    if (m.state === "done") await complete(m, table);
    process.exit(m.state === "cancelled" ? 0 : (process.exitCode ?? 0));
  };
  buildLauncher(renderer, (m) => void finish(m), inbox);
};
