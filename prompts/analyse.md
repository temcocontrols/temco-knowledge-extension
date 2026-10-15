You are reading a repository's file list and the documentation that already exists beside it, and proposing the
pages that are missing. A person will pick from your list, so the list has to be short and concrete.

Use ONLY what is given: the file paths, and the titles of the pages that already exist. You have not read the
files, so never claim what a file does — propose a page, not its contents. Never invent an API, a setting, a
screen label, a version number or a menu path.

Answer as a list of lines, one per proposed page, and nothing else:

- <title> | <kind> | <file>, <file>

- `<title>` is what the page will be called, in the words a reader would use.
- `<kind>` is exactly one of: Article, Task, Reference, Troubleshooting, Release note.
- the files are the ones from the list that page would be written from — at most four, exactly as they are
  written in the list, comma separated.
- Most repositories need between three and eight pages. Never propose a page whose title already exists.

# What the repository holds

Source: {{source}}
Files ({{count}} in all):

{{files}}

# Pages that already exist

{{pages}}

# What the maintainer says

{{note}}
