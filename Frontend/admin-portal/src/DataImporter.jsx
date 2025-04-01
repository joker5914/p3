import React, { useState } from "react";
import Papa from "papaparse";
import axios from "axios";
import "./DataImporter.css";

export default function DataImporter() {
  const [csvFile, setCsvFile] = useState(null);
  const [parsedData, setParsedData] = useState([]);
  const [uploadStatus, setUploadStatus] = useState("");

  const handleFileChange = (e) => {
    setCsvFile(e.target.files[0]);
  };

  const parseCSV = () => {
    if (!csvFile) return;
    Papa.parse(csvFile, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setParsedData(results.data);
      }
    });
  };

  const uploadData = async () => {
    try {
      setUploadStatus("Uploading...");
      const token = localStorage.getItem("idToken");
      await axios.post("/api/v1/admin/import", parsedData, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setUploadStatus("✅ Upload successful!");
    } catch (err) {
      console.error("Upload failed", err);
      setUploadStatus("❌ Upload failed. Check console.");
    }
  };

  return (
    <div className="data-importer-wrapper">
      <div className="upload-section">
        <h2 className="upload-title">Data Importer</h2>
        <div className="upload-controls">
          <label className="file-label">
            Choose File
            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="file-input"
            />
          </label>
          <button className="btn parse-btn" onClick={parseCSV}>
            Parse Data
          </button>
          {parsedData.length > 0 && (
            <button className="btn upload-btn" onClick={uploadData}>
              Upload to Server
            </button>
          )}
          <p className="status">{uploadStatus}</p>
        </div>
      </div>
      <div className="instructions-section">
        <h3 className="instructions-title">Operator Notes</h3>
        <p>
          <strong>File Format:</strong> Upload a CSV file with a header row.
        </p>
        <p>
          <strong>Required Columns:</strong> Ensure the CSV includes columns for{" "}
          <em>student_names</em> (use semicolons to separate multiple names),{" "}
          <em>parent_name</em>, <em>plate</em>, <em>location</em>, and{" "}
          <em>confidence_score</em>.
        </p>
        <p>
          <strong>Accepted File Types:</strong> Only CSV (.csv) files are accepted.
        </p>
        <p>
          <strong>Formatting:</strong> Each row should represent one record. For multiple
          children, list their names separated by semicolons.
        </p>
        <p>
          <strong>Example:</strong>
          <br />
          student_names: John Doe; Jane Doe
          <br />
          parent_name: Michael Doe
          <br />
          plate: ABC123
          <br />
          location: Entrance Gate 1
          <br />
          confidence_score: 0.95
        </p>
        <p>
          Ensure all fields are correctly formatted. Missing or incorrectly formatted
          fields may cause import errors.
        </p>
      </div>
    </div>
  );
}
