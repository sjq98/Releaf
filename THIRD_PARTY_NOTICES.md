# Third-Party Notices

Releaf retains the Apache License 2.0 already present in this repository. The runtime and dependency notices below do not replace that license.

## Lucide 1.60.0

The app serves the installed Lucide bundle from `node_modules/lucide/dist/umd/lucide.min.js`. The complete upstream license is distributed with the package as `node_modules/lucide/LICENSE`; it includes ISC terms and MIT terms for Feather-derived icons. Preserve those notices when redistributing the bundle.

Source: https://github.com/lucide-icons/lucide

## Spreadsheet, Document and Arithmetic Libraries

- ExcelJS 4.4.0: MIT, https://github.com/exceljs/exceljs
- csv-parse 7.0.3: MIT, https://github.com/adaltas/node-csv
- PDF.js (`pdfjs-dist`) 6.4.299: Apache-2.0, https://github.com/mozilla/pdf.js
- Decimal.js 10.6.0: MIT, https://github.com/MikeMcl/decimal.js

The browser serves the installed PDF.js main and worker bundles. Preserve their Apache-2.0 notices and the other packages' licenses when redistributing. Dependency licenses are included in the installed npm packages; `package-lock.json` records exact transitive versions. ExcelJS's UUID dependency is overridden to 11.1.1; its MIT license remains applicable.

## Node.js and SQLite

Node.js and its bundled dependencies carry their own notices. SQLite is provided through Node.js's built-in `node:sqlite` module. Consult the installed Node.js distribution's license and third-party notices when distributing a runtime.

## Organizer Documentation

The README layout and submission checklist were adapted from the organizer's Apache-2.0 submission template:
https://github.com/michaelzhngg/SDC_Hackathon_Submission_Template

The application code is this project's implementation; the organizer's sample Python app and RunPod handler were not copied. Submission notes paraphrase the organizer's requirements and identify their sources. No organizer template or sample proof is represented as a completed team document.
