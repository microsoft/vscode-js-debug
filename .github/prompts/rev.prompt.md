---
name: rev
description: Update the version
---

<!-- Tip: Use /create-prompt in chat to generate content with agent assistance -->

The user will give you a target revision version.

0. Check out a new branch `rev/<version>`
1. Review the changes since the last released version
2. Update the CHANGELOG.md as necessary, creating a header for the current version, adding any new notes in there in the style of existing notes, and then adding a new "Unreleased" header
3. Use the "ask questions" tool to confirm with the user that the notes are good or ask for their feedback on the generated notes
4. Update the version in the package.json, then run `npm install` so the package-lock is updated to
5. Commit everything as `chore: prep v<version>`, create a PR, and set it to auto-merge
