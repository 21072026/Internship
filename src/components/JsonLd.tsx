// Structured data (#1382): one schema.org object as a
// `<script type="application/ld+json">`. Server-only by construction — it has
// no state and runs nowhere else.
//
// The escape is the whole point of the component. The payload is dictionary
// copy and project data, and a `</script>` inside any string would end the
// tag and turn the rest into markup; `<`, `>` and `&` go out as \u escapes,
// which JSON.parse reads back unchanged. U+2028/U+2029 are escaped too — legal
// in JSON, not in an older JS parser.
export function jsonLdString(data: object): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />;
}
