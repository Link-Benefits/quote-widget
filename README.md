# Link Benefits quote widgets (published copy)

Static files GitHub Pages serves to Link Benefits' Jotform forms:

- `index.html`: the ancillary quote widget
- `medical.html`: the small group medical widget
- `census-template.xlsx`: the census template the ancillary widget links to

**Do not edit here.** Every publish overwrites this repo from Link Benefits' private source (`Jotform quote widget/tools/publish-widget.js`); each commit names the source commit.

It holds no keys, no client data and no rates. The widgets read the form's answers and a census in the visitor's own browser and send nothing anywhere (the pages' Content-Security-Policy blocks every connection); their answer travels with the form submission like any other question.
