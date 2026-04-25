import React, { useState, useRef, useCallback } from "react";
import Papa from "papaparse";
import { I } from "./components/icons";
import { createApiClient } from "./api";
import "./DataImporter.css";

const REQUIRED_COLUMNS = [
  "guardian_id",
  "guardian_name",
  "student_id",
  "student_name",
  "plate_number",
];

export default function DataImporter({ token, schoolId = null }) {
  const [csvFile,     setCsvFile]     = useState(null);
  const [parsedData,  setParsedData]  = useState([]);
  const [parseErrors, setParseErrors] = useState([]);
  const [uploadStatus,setUploadStatus]= useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver,    setDragOver]    = useState(false);

  const fileInputRef = useRef(null);

  const resetState = () => {
    setParsedData([]);
    setParseErrors([]);
    setUploadStatus("");
  };

  const setFile = (file) => {
    if (!file) return;
    setCsvFile(file);
    resetState();
  };

  const handleFileChange  = (e) => setFile(e.target.files[0] || null);
  const handleDragOver    = (e) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave   = ()  => setDragOver(false);
  const handleDrop        = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.name?.endsWith(".csv")) setFile(file);
    else setUploadStatus("Please drop a .csv file.");
  };

  const parseCSV = useCallback(() => {
    if (!csvFile) { setUploadStatus("Please select a CSV file first."); return; }
    Papa.parse(csvFile, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
      complete: ({ data, errors }) => {
        const msgs = errors.map((e) => e.message);
        const firstRow = data[0] || {};
        const missing = REQUIRED_COLUMNS.filter((col) => !(col in firstRow));
        if (missing.length) {
          msgs.push(`Missing required columns: ${missing.join(", ")}`);
          setParseErrors(msgs);
          setParsedData([]);
          return;
        }
        setParseErrors(msgs);
        setParsedData(data);
        setUploadStatus(`Parsed ${data.length} row(s). Review below, then upload.`);
      },
    });
  }, [csvFile]);

  const uploadData = async () => {
    if (!parsedData.length) return;
    setIsUploading(true);
    setUploadStatus("Uploading…");
    try {
      const res = await createApiClient(token, schoolId).post("/api/v1/admin/import-plates", parsedData);
      setUploadStatus(`Import complete — ${res.data.plate_count} plate(s) registered.`);
      setParsedData([]);
      setCsvFile(null);
    } catch (err) {
      setUploadStatus(`Upload failed: ${err.response?.data?.detail || err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="data-importer-wrapper">
      {/* ── Upload panel ── */}
      <div className="upload-section">
        <h2 className="upload-title">Data Import</h2>

        {/* Drop zone — implemented as a <label> so clicking/enter opens the
            file picker natively (no onClick handler needed) and screen
            readers announce it as the file input's label. */}
        <label
          className={`drop-zone${dragOver ? " drag-over" : ""}`}
          htmlFor="csv-file-input"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            id="csv-file-input"
            type="file"
            accept=".csv"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="file-input"
            aria-describedby="drop-zone-hint"
          />
          <div className="drop-zone-icon" aria-hidden="true">
            <I.upload size={28} stroke={1.5} />
          </div>
          {csvFile ? (
            <span className="drop-zone-file">
              <I.layers size={14} aria-hidden="true" />
              {csvFile.name}
            </span>
          ) : (
            <>
              <div className="drop-zone-title">Drop your CSV here</div>
              <div id="drop-zone-hint" className="drop-zone-sub">
                or click to browse files
              </div>
            </>
          )}
        </label>

        {/* Actions */}
        <div className="upload-actions">
          <button className="btn parse-btn" onClick={parseCSV} disabled={!csvFile}>
            Parse CSV
          </button>
          {parsedData.length > 0 && (
            <button className="btn upload-btn" onClick={uploadData} disabled={isUploading}>
              {isUploading ? "Uploading…" : `Upload ${parsedData.length} record${parsedData.length !== 1 ? "s" : ""}`}
            </button>
          )}
        </div>

        {uploadStatus && (
          <p className="status-msg" role="status" aria-live="polite">
            {uploadStatus}
          </p>
        )}
        {parseErrors.length > 0 && (
          <ul className="error-list" role="alert">
            {parseErrors.map((e, i) => <li key={i} className="error-item">{e}</li>)}
          </ul>
        )}

        {/* Preview */}
        {parsedData.length > 0 && (
          <div className="preview-container">
            <div className="preview-header">
              Preview — {parsedData.length} row{parsedData.length !== 1 ? "s" : ""}
              {parsedData.length > 10 && ` (showing first 10)`}
            </div>
            <div className="table-scroll">
              <table className="preview-table">
                <thead>
                  <tr>{Object.keys(parsedData[0]).map((col) => <th key={col}>{col}</th>)}</tr>
                </thead>
                <tbody>
                  {parsedData.slice(0, 10).map((row, i) => (
                    <tr key={i}>{Object.values(row).map((val, j) => <td key={j}>{val}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Instructions ── */}
      <div className="instructions-section">
        <div className="instructions-title">Format Guide</div>

        <p><strong>Required columns:</strong></p>
        <ul>
          {REQUIRED_COLUMNS.map((col) => <li key={col}><code>{col}</code></li>)}
        </ul>

        <p><strong>Optional:</strong></p>
        <ul>
          {["vehicle_make", "vehicle_model", "vehicle_color"].map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>

        <p><strong>Multiple children:</strong> Add one row per child with the same <code>plate_number</code> — they are grouped automatically.</p>

        <p><strong>Example:</strong></p>
        <pre className="example-csv">{`guardian_id,guardian_name,student_id,student_name,plate_number\njdoe@example.com,Jane Doe,stu001,John Doe,ABC123\njdoe@example.com,Jane Doe,stu002,Jenny Doe,ABC123`}</pre>

        <div className="security-note">
          <I.shield size={14} stroke={2.2} aria-hidden="true" />
          <span>All PII is encrypted server-side before storage. Plate numbers are one-way tokenised and never stored in plaintext.</span>
        </div>
      </div>
    </div>
  );
}
