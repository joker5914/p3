import React, { useState } from "react";
import Papa from "papaparse";
import { createApiClient } from "./api";
import "./DataImporter.css";

const REQUIRED_COLUMNS = [
  "guardian_id",
  "guardian_name",
  "student_id",
  "student_name",
  "plate_number",
];

export default function DataImporter({ token }) {
  const [csvFile, setCsvFile] = useState(null);
  const [parsedData, setParsedData] = useState([]);
  const [parseErrors, setParseErrors] = useState([]);
  const [uploadStatus, setUploadStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const handleFileChange = (e) => {
    setCsvFile(e.target.files[0] || null);
    setParsedData([]);
    setParseErrors([]);
    setUploadStatus("");
  };

  const parseCSV = () => {
    if (!csvFile) {
      setUploadStatus("Please select a CSV file first.");
      return;
    }
    Papa.parse(csvFile, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
      complete: ({ data, errors }) => {
        if (errors.length) {
          setParseErrors(errors.map((e) => e.message));
        }
        const firstRow = data[0] || {};
        const missing = REQUIRED_COLUMNS.filter((col) => !(col in firstRow));
        if (missing.length) {
          setParseErrors((prev) => [
            ...prev,
            `Missing required columns: ${missing.join(", ")}`,
          ]);
          setParsedData([]);
          return;
        }
        setParsedData(data);
        setUploadStatus(`Parsed ${data.length} row(s). Review below, then upload.`);
      },
    });
  };

  const uploadData = async () => {
    if (!parsedData.length) return;
    setIsUploading(true);
    setUploadStatus("Uploading…");
    try {
      const api = createApiClient(token);
      const res = await api.post("/api/v1/admin/import-plates", parsedData);
      setUploadStatus(`Import complete — ${res.data.plate_count} plate(s) registered.`);
      setParsedData([]);
      setCsvFile(null);
    } catch (err) {
      const detail = err.response?.data?.detail || err.message;
      setUploadStatus(`Upload failed: ${detail}`);
      console.error("Upload error:", err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="data-importer-wrapper">
      <div className="upload-section">
        <h2 className="upload-title">Data Importer</h2>
        <div className="upload-controls">
          <label className="file-label">
            {csvFile ? csvFile.name : "Choose CSV File"}
            <input type="file" accept=".csv" onChange={handleFileChange} className="file-input" />
          </label>
          <button className="btn parse-btn" onClick={parseCSV} disabled={!csvFile}>
            Parse CSV
          </button>
          {parsedData.length > 0 && (
            <button className="btn upload-btn" onClick={uploadData} disabled={isUploading}>
              {isUploading ? "Uploading…" : `Upload ${parsedData.length} Record(s)`}
            </button>
          )}
          {uploadStatus && <p className="status">{uploadStatus}</p>}
          {parseErrors.length > 0 && (
            <ul className="error-list">
              {parseErrors.map((e, i) => (<li key={i} className="error-item">{e}</li>))}
            </ul>
          )}
        </div>
        {parsedData.length > 0 && (
          <div className="preview-container">
            <h4>Preview ({parsedData.length} rows)</h4>
            <div className="table-scroll">
              <table className="preview-table">
                <thead><tr>{Object.keys(parsedData[0]).map((col) => (<th key={col}>{col}</th>))}</tr></thead>
                <tbody>
                  {parsedData.slice(0, 10).map((row, i) => (
                    <tr key={i}>{Object.values(row).map((val, j) => (<td key={j}>{val}</td>))}</tr>
                  ))}
                  {parsedData.length > 10 && (
                    <tr><td colSpan={Object.keys(parsedData[0]).length} style={{textAlign:"center",color:"#888"}}>…and {parsedData.length - 10} more rows</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <div className="instructions-section">
        <h3 className="instructions-title">Operator Notes</h3>
        <p><strong>Required Columns:</strong></p>
        <ul>{REQUIRED_COLUMNS.map((col) => (<li key={col}><code>{col}</code></li>))}</ul>
        <p><strong>Optional:</strong> <code>vehicle_make</code>, <code>vehicle_model</code>, <code>vehicle_color</code></p>
        <p><strong>Multiple Children:</strong> Add one row per child sharing the same <code>plate_number</code> — they are grouped automatically.</p>
        <p><strong>Example:</strong></p>
        <pre className="example-csv">{`guardian_id,guardian_name,student_id,student_name,plate_number\njdoe@example.com,Jane Doe,stu001,John Doe,ABC123\njdoe@example.com,Jane Doe,stu002,Jenny Doe,ABC123`}</pre>
        <p>All PII is <strong>encrypted</strong> server-side before storage. Plates are one-way tokenised.</p>
      </div>
    </div>
  );
}
