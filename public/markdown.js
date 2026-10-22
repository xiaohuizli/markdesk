// Add source ranges to standard Markdown blocks without enabling raw HTML.
export function renderMarkdown(parser, text) {
  const tokens = parser.parse(text, {});
  const annotate = (items) => {
    for (const token of items) {
      if (token.map && token.nesting !== -1) {
        token.attrSet('data-source-start', String(token.map[0] + 1));
        token.attrSet('data-source-end', String(token.map[1]));
      }
      if (token.children) annotate(token.children);
    }
  };
  annotate(tokens);
  return parser.renderer.render(tokens, parser.options, {});
}
