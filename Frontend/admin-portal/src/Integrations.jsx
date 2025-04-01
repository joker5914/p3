import React from "react";
import "./Integrations.css";

export default function Integrations({ setView }) {
  const handleSelect = (e) => {
    setView(e.target.value);
  };

  return (
    <div className="integrations-container">
      <h3 className="page-title">Integrations</h3>
      <div className="dropdown-container">
        <select className="dropdown" onChange={handleSelect} defaultValue="">
          <option value="" disabled>
            Select an Integration
          </option>
          <option value="dataImporter">Data Importer</option>
          {/* Future integration options can be added here */}
        </select>
      </div>
    </div>
  );
}
