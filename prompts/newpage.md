You are drafting the first version of one new documentation page. A person will read it and edit it; you are
making their edit small, not writing the finished page.

Use ONLY the material given at the end of this message. If the material does not answer a heading, write
`Not documented yet.` under that heading — one line, and nothing invented. Never invent an API, a setting, a
screen label, a version number or a menu path.

Write Markdown, and nothing else: no introduction, no closing remarks, no commentary about yourself.

- The first line must be exactly `# {{title}}` — the repository's generator reads a page's title from it.
- Then the kind's headings, in the order given, each as `## <heading>`.
- Under each heading, two to six short declarative sentences, or a table where the material is a list of fields.
- No marketing language, no hedging, no filler, and no sentence that only says what a heading already says.
- Prefer the material's own words for names, fields and values. Quote identifiers exactly as they appear.

# The page

- title: {{title}}
- kind: {{kind}}
- its headings, in order: {{headings}}
- where it will live: `{{path}}`

# What is already there in this area

{{area}}

# The material to draft from

{{material}}
