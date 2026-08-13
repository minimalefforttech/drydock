/**
 * The four value editors the Configure panel needs (UX overhaul P6).
 *
 * Every editor is "commit on blur / Enter": there is no Save button anywhere in
 * Configure, so a control's job is to hand a finished value to its caller
 * exactly once. Escape restores the value the row came in with.
 *
 * SECURITY: DOM built node by node, all text via textContent. The panel's
 * strict CSP has no 'unsafe-inline' for styles, so every visual state is a
 * CLASS - there is not one style attribute in this module.
 */

import type { ConfigTagRuleInput } from "@drydock/contracts";

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.title = title;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return node;
}

/** A checkbox rendered as the row's control; the label lives in the row. */
export function toggleField(value: boolean, label: string, disabled: boolean, commit: (next: boolean) => void): HTMLElement {
  const wrap = el("label", "cfg-toggle");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  input.disabled = disabled;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => { commit(input.checked); });
  const track = el("span", "cfg-toggle-track");
  wrap.append(input, track);
  return wrap;
}

/** Single-line text (or number) that commits on blur and Enter. */
export function textField(
  value: string,
  options: {
    readonly kind?: "text" | "number";
    readonly placeholder?: string;
    readonly label: string;
    readonly disabled?: boolean;
    readonly min?: number;
    readonly max?: number;
    /** Native spinner/validity granularity; only meaningful for kind "number". */
    readonly step?: number;
  },
  commit: (next: string) => void
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = options.kind === "number" ? "number" : "text";
  input.className = "cfg-input";
  input.value = value;
  input.setAttribute("aria-label", options.label);
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;
  if (options.disabled === true) input.disabled = true;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.step !== undefined) input.step = String(options.step);
  let committed = value;
  const send = (): void => {
    if (input.value === committed) return;
    committed = input.value;
    commit(input.value);
  };
  input.addEventListener("blur", send);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = committed;
      input.blur();
    }
  });
  return input;
}

export function selectField(
  options: readonly { readonly value: string; readonly label: string }[],
  selected: string,
  label: string,
  commit: (next: string) => void
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "cfg-select";
  select.setAttribute("aria-label", label);
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (option.value === selected) node.selected = true;
    select.append(node);
  }
  select.addEventListener("change", () => { commit(select.value); });
  return select;
}

/**
 * An ordered list of strings: one row each with a remove button, plus a single
 * "add" line. Every mutation commits the WHOLE list, so the setting is written
 * once per edit and the row can report itself saved.
 */
export function stringListField(
  values: readonly string[],
  options: { readonly label: string; readonly placeholder: string; readonly disabled?: boolean },
  commit: (next: readonly string[]) => void
): HTMLElement {
  const wrap = el("div", "cfg-list");
  values.forEach((value, index) => {
    const row = el("div", "cfg-list-row");
    row.append(textField(value, {
      label: `${options.label} ${String(index + 1)}`,
      ...(options.disabled === true ? { disabled: true } : {})
    }, (next) => {
      const trimmed = next.trim();
      const updated = [...values];
      if (trimmed.length === 0) updated.splice(index, 1);
      else updated[index] = trimmed;
      commit(updated);
    }));
    if (options.disabled !== true) {
      row.append(button("cfg-icon-button", "×", `Remove ${value}`, () => {
        commit(values.filter((_, position) => position !== index));
      }));
    }
    wrap.append(row);
  });
  if (options.disabled !== true) {
    const add = el("div", "cfg-list-row cfg-list-add");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cfg-input";
    input.placeholder = options.placeholder;
    input.setAttribute("aria-label", `Add to ${options.label}`);
    const submit = (): void => {
      const next = input.value.trim();
      if (next.length === 0) return;
      input.value = "";
      commit([...values, next]);
    };
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
    add.append(input, button("cfg-icon-button", "+", `Add to ${options.label}`, submit));
    wrap.append(add);
  }
  return wrap;
}

/** Key/value rows plus an add line; commits the whole map on every change. */
export function stringMapField(
  value: Readonly<Record<string, string>>,
  options: { readonly label: string; readonly disabled?: boolean },
  commit: (next: Record<string, string>) => void
): HTMLElement {
  const wrap = el("div", "cfg-list");
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries) {
    const row = el("div", "cfg-list-row cfg-pair-row");
    const name = el("span", "cfg-pair-key");
    name.textContent = key;
    row.append(name);
    row.append(textField(entryValue, {
      label: `${key} value`,
      ...(options.disabled === true ? { disabled: true } : {})
    }, (next) => {
      commit({ ...value, [key]: next });
    }));
    if (options.disabled !== true) {
      row.append(button("cfg-icon-button", "×", `Remove ${key}`, () => {
        const updated = { ...value };
        delete updated[key];
        commit(updated);
      }));
    }
    wrap.append(row);
  }
  if (options.disabled !== true) {
    const add = el("div", "cfg-list-row cfg-pair-row");
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "cfg-input cfg-input-key";
    keyInput.placeholder = "NAME";
    keyInput.setAttribute("aria-label", `New ${options.label} name`);
    const valueInput = document.createElement("input");
    valueInput.type = "text";
    valueInput.className = "cfg-input";
    valueInput.placeholder = "value";
    valueInput.setAttribute("aria-label", `New ${options.label} value`);
    const submit = (): void => {
      const key = keyInput.value.trim();
      if (key.length === 0) return;
      const next = { ...value, [key]: valueInput.value };
      keyInput.value = "";
      valueInput.value = "";
      commit(next);
    };
    for (const input of [keyInput, valueInput]) {
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submit();
      });
    }
    add.append(keyInput, valueInput, button("cfg-icon-button", "+", `Add to ${options.label}`, submit));
    wrap.append(add);
  }
  return wrap;
}

/**
 * The memory tag-rule table: comma-separated globs on the left, one tag on the
 * right. Only the settings rows are editable; the shipped defaults render
 * beside them as read-only rows (the caller supplies those separately).
 */
export function tagRulesField(
  rules: readonly ConfigTagRuleInput[],
  commit: (next: readonly ConfigTagRuleInput[]) => void
): HTMLElement {
  const wrap = el("div", "cfg-list");
  rules.forEach((rule, index) => {
    const row = el("div", "cfg-list-row cfg-rule-row");
    row.append(textField(rule.globs.join(", "), { label: `Rule ${String(index + 1)} patterns` }, (next) => {
      const globs = splitGlobs(next);
      const updated = [...rules];
      if (globs.length === 0) updated.splice(index, 1);
      else updated[index] = { globs, tag: rule.tag };
      commit(updated);
    }));
    row.append(el("span", "cfg-rule-arrow", "→"));
    row.append(textField(rule.tag, { label: `Rule ${String(index + 1)} tag` }, (next) => {
      const tag = next.trim().toLowerCase();
      const updated = [...rules];
      if (tag.length === 0) updated.splice(index, 1);
      else updated[index] = { globs: rule.globs, tag };
      commit(updated);
    }));
    row.append(button("cfg-icon-button", "×", `Remove the ${rule.tag} rule`, () => {
      commit(rules.filter((_, position) => position !== index));
    }));
    wrap.append(row);
  });
  const add = el("div", "cfg-list-row cfg-rule-row");
  const globsInput = document.createElement("input");
  globsInput.type = "text";
  globsInput.className = "cfg-input";
  globsInput.placeholder = "*.usd, *.usda";
  globsInput.setAttribute("aria-label", "New rule patterns");
  const tagInput = document.createElement("input");
  tagInput.type = "text";
  tagInput.className = "cfg-input";
  tagInput.placeholder = "usd";
  tagInput.setAttribute("aria-label", "New rule tag");
  const submit = (): void => {
    const globs = splitGlobs(globsInput.value);
    const tag = tagInput.value.trim().toLowerCase();
    if (globs.length === 0 || tag.length === 0) return;
    globsInput.value = "";
    tagInput.value = "";
    commit([...rules, { globs, tag }]);
  };
  for (const input of [globsInput, tagInput]) {
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submit();
    });
  }
  add.append(globsInput, el("span", "cfg-rule-arrow", "→"), tagInput, button("cfg-icon-button", "+", "Add a tag rule", submit));
  wrap.append(add);
  return wrap;
}

function splitGlobs(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
