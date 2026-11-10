# JNW Engineering Job Order

## Chinese and Tamil entry

Complaint, Action Taken and Remarks accept Chinese or Tamil input. Press the field's
**Translate to English** button to replace its contents with editable English.
Review the English before submitting. Only the final field contents are saved;
no separate original/translated versions are retained. Translation requires internet
access and sends that field's text to Azure Translator. Form labels stay in English.

Configure these server-side Azure App Service application settings, then restart:

- `AZURE_TRANSLATOR_KEY`: Azure Translator resource key (never put it in HTML or Git).
- `AZURE_TRANSLATOR_REGION`: resource region, required for regional/multi-service resources;
  omit for a global Translator resource.

The server uses the Translator v3 global text endpoint with automatic source language
detection and English output. Each click permits up to 5,000 characters. Failure leaves
the field unchanged. No key is bundled; without configuration the button reports that
translation is not configured. Use a supported Node.js runtime with built-in fetch
(the existing Azure workflow uses Node 22).

Run `npm test` for mocked integration/behaviour checks. Validate real Chinese and Tamil
examples with bilingual staff after configuring the resource. Check service usage/cost
and restrict access to the app before enabling the paid translation endpoint publicly.

Standalone mobile Job Order form for JNW Engineering.

## Link

Technicians open the Azure web app link.

## Reports

When technicians press `Submit`, the completed report is saved as a PDF in company OneDrive/SharePoint:

```text
Documents / Mobile Job Order Reports / 2026
```

The year folder is created automatically from the job order date. For example,
2027 reports go to `Documents / Mobile Job Order Reports / 2027`.

PDF file name format:

```text
JO XX _ Customer Name _ Date.pdf
```

Example:

```text
JO 03 _ JNW _ 31-07-2026.pdf
```

## Notes

The Azure web app needs SharePoint permission before submissions can upload PDFs.
To save into a specific OneDrive instead, set the Azure app setting
`GRAPH_DRIVE_ID` to that OneDrive drive ID.
