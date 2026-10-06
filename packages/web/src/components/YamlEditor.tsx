import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ScenarioIssue } from "../api";

/**
 * Editor YAML (CodeMirror 6) com validação em tempo real: `validate` é chamado com atraso após
 * cada edição e devolve problemas com linha/coluna, que viram marcações no texto e na calha.
 */
export interface YamlEditorHandle {
  goTo(line: number, col?: number): void;
}

/** Realce com as variáveis do tema: legível no claro e no escuro (o padrão só serve no claro). */
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--s1)" },
    { tag: [t.string, t.special(t.string)], color: "var(--s3)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--s2)" },
    { tag: [t.comment, t.lineComment], color: "var(--muted)", fontStyle: "italic" },
    {
      tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.brace],
      color: "var(--ink-2)",
    },
    { tag: [t.keyword, t.meta, t.labelName], color: "var(--serious)" },
  ]),
);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--raised)", color: "var(--ink)" },
  ".cm-content": {
    caretColor: "var(--ink)",
    fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--wash)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--wash)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(57,135,229,0.25)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    color: "var(--ink)",
    border: "1px solid var(--border)",
  },
});

export function YamlEditor({
  value,
  onChange,
  validate,
  handleRef,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  validate: (text: string) => Promise<ScenarioIssue[]>;
  handleRef?: (h: YamlEditorHandle) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, validate });
  cb.current = { onChange, validate };

  useEffect(() => {
    const lint = linter(
      async (v): Promise<Diagnostic[]> => {
        const doc = v.state.doc;
        const issues = await cb.current.validate(doc.toString());
        return issues.map((i) => {
          const line = doc.line(Math.min(Math.max(1, i.line ?? 1), doc.lines));
          const from = Math.min(line.from + Math.max(0, (i.col ?? 1) - 1), line.to);
          return {
            from,
            to: Math.max(from, line.to),
            severity: "error",
            message: `${i.path ? `${i.path}: ` : ""}${i.message}`,
          };
        });
      },
      { delay: 450 },
    );
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          yaml(),
          highlight,
          lint,
          lintGutter(),
          theme,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    handleRef?.({
      goTo(line, col = 1) {
        const doc = v.state.doc;
        const l = doc.line(Math.min(Math.max(1, line), doc.lines));
        const pos = Math.min(l.from + col - 1, l.to);
        v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        v.focus();
      },
    });
    return () => v.destroy();
    // o editor é criado uma vez por documento (a chave do componente muda ao trocar de cenário)
  }, []);

  return <div className="editor-wrap" ref={host} />;
}
