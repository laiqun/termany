/**
 * The main "mammoth" package's types only cover its Node-oriented entry
 * point; we import the pre-bundled browser build directly (see
 * OfficePreview.tsx) since that's the officially documented way to use
 * mammoth in a browser bundle without pulling in its Node-only deps.
 */
declare module "mammoth/mammoth.browser.js" {
  import type mammoth from "mammoth";
  const value: typeof mammoth;
  export default value;
  export const convertToHtml: typeof mammoth.convertToHtml;
  export const extractRawText: typeof mammoth.extractRawText;
}
