// Empty stub aliased in place of CSS imports (e.g. katex's stylesheet) during
// tests - happy-dom can't process a real stylesheet and KaTeX warns/blanks the
// render in quirks mode. The styles are irrelevant to the component logic the
// tests assert on.
export default {};
