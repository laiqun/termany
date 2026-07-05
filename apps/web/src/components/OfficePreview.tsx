import { useEffect, useRef, useState } from "react";

/**
 * docx/xlsx/pptx rendering libraries are only pulled in (via dynamic import)
 * once a file of that type is actually opened — each is a sizeable dependency
 * (mammoth, SheetJS, pptx-preview + echarts) that would otherwise bloat the
 * app's main bundle for users who never open an Office file.
 */

type FetchState =
  | { status: "loading" }
  | { status: "ready"; buffer: ArrayBuffer }
  | { status: "error"; error: string };

function useArrayBuffer(src: string): FetchState {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetch(src)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (live) setState({ status: "ready", buffer });
      })
      .catch((e) => {
        if (live) setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [src]);
  return state;
}

function OfficeStatus({ children }: { children: React.ReactNode }) {
  return <div className="office-preview-status">{children}</div>;
}

const DOCX_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; color: #1a1a1a; background: #fff; max-width: 800px; margin: 0 auto; padding: 32px 44px 64px; }
  table { border-collapse: collapse; margin: 12px 0; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; }
  img { max-width: 100%; }
  h1, h2, h3, h4 { line-height: 1.3; }
`;

export function DocxPreview({ src }: { src: string }) {
  const fetchState = useArrayBuffer(src);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fetchState.status !== "ready") return;
    let live = true;
    setHtml(null);
    setError(null);
    import("mammoth/mammoth.browser.js")
      .then((mod) => mod.default.convertToHtml({ arrayBuffer: fetchState.buffer }))
      .then((result) => {
        if (live) setHtml(result.value);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [fetchState]);

  if (fetchState.status === "error") return <OfficeStatus>{fetchState.error}</OfficeStatus>;
  if (error) return <OfficeStatus>Could not render this document: {error}</OfficeStatus>;
  if (html === null) return <OfficeStatus>Loading preview…</OfficeStatus>;

  return (
    <iframe
      className="office-preview docx-preview"
      title="Document preview"
      sandbox=""
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>${DOCX_STYLE}</style></head><body>${html}</body></html>`}
    />
  );
}

export function XlsxPreview({ src }: { src: string }) {
  const fetchState = useArrayBuffer(src);
  const [sheetNames, setSheetNames] = useState<string[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const workbookRef = useRef<{ XLSX: typeof import("xlsx"); workbook: import("xlsx").WorkBook } | null>(null);
  const [tableHtml, setTableHtml] = useState<Record<number, string>>({});

  useEffect(() => {
    if (fetchState.status !== "ready") return;
    let live = true;
    setSheetNames(null);
    setTableHtml({});
    setActiveSheet(0);
    setError(null);
    import("xlsx")
      .then((XLSX) => {
        if (!live) return;
        const workbook = XLSX.read(fetchState.buffer, { type: "array" });
        workbookRef.current = { XLSX, workbook };
        setSheetNames(workbook.SheetNames);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [fetchState]);

  useEffect(() => {
    if (!sheetNames || !workbookRef.current || tableHtml[activeSheet] !== undefined) return;
    const { XLSX, workbook } = workbookRef.current;
    const sheet = workbook.Sheets[sheetNames[activeSheet]];
    const html = sheet && sheet["!ref"] ? XLSX.utils.sheet_to_html(sheet, { header: "", footer: "" }) : "<p>Empty sheet</p>";
    setTableHtml((prev) => ({ ...prev, [activeSheet]: html }));
  }, [sheetNames, activeSheet, tableHtml]);

  if (fetchState.status === "error") return <OfficeStatus>{fetchState.error}</OfficeStatus>;
  if (error) return <OfficeStatus>Could not render this spreadsheet: {error}</OfficeStatus>;
  if (!sheetNames) return <OfficeStatus>Loading preview…</OfficeStatus>;

  return (
    <div className="xlsx-preview">
      {sheetNames.length > 1 && (
        <div className="xlsx-sheet-tabs">
          {sheetNames.map((name, i) => (
            <button
              key={name}
              className={`xlsx-sheet-tab ${i === activeSheet ? "active" : ""}`}
              onClick={() => setActiveSheet(i)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div className="xlsx-sheet-body" dangerouslySetInnerHTML={{ __html: tableHtml[activeSheet] ?? "" }} />
    </div>
  );
}

export function PptxPreview({ src }: { src: string }) {
  const fetchState = useArrayBuffer(src);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (fetchState.status !== "ready" || !containerRef.current) return;
    let live = true;
    setReady(false);
    setError(null);
    const container = containerRef.current;
    container.innerHTML = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped viewer instance from a lib without a matching type import path here
    let viewer: any = null;
    import("pptx-preview")
      .then(({ init }) => {
        if (!live) return;
        // No `height`: passing one makes the library clip the rendered
        // slides to that fixed box (with its own internal scrollbar) —
        // omitting it lets each slide's height derive proportionally from
        // its actual (often non-16:9) aspect ratio, and the outer panel
        // (already `overflow: auto`) scrolls the whole stacked list instead.
        viewer = init(container, { width: 960, mode: "list" });
        return viewer.preview(fetchState.buffer);
      })
      .then(() => {
        if (live) setReady(true);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      viewer?.destroy?.();
    };
  }, [fetchState]);

  if (fetchState.status === "error") return <OfficeStatus>{fetchState.error}</OfficeStatus>;
  if (error) return <OfficeStatus>Could not render this presentation: {error}</OfficeStatus>;

  return (
    <div className="pptx-preview">
      {!ready && <OfficeStatus>Loading preview…</OfficeStatus>}
      <div className="pptx-preview-slides" ref={containerRef} />
    </div>
  );
}
