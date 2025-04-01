import React from "react";
import { FaCarSide } from "react-icons/fa";
import "./Dashboard.css";

export default function Dashboard({ queue }) {
  return (
    <div className="dashboard-container">
      <h3 className="dashboard-title">Current Pickup Queue</h3>
      {queue.length === 0 ? (
        <div className="empty-message">No scans available.</div>
      ) : (
        <div className="cards-container">
          {queue.map((entry, index) => {
            // Format time with numeric hour (no leading zero) and 2-digit minute.
            const timeString = new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            });
            return (
              <div key={index} className="card">
                <div className="badge">{index + 1}</div>
                <div className="card-header">
                  <FaCarSide className="car-icon" />
                  <div className="time">{timeString}</div>
                </div>
                <div className="card-content">
                  <div className="info">
                    <div className="info-row">
                      <span className="label">Parent:</span>
                      <span className="value">{entry.parent || "N/A"}</span>
                    </div>
                    <div className="info-row">
                    {Array.isArray(entry.student) ? (
                        <>
                            <span className="label">Children:</span>
                            <span className="value">{entry.student.join(", ")}</span>
                        </>
                        ) : (
                        <>
                            <span className="label">Child:</span>
                            <span className="value">{entry.student || "N/A"}</span>
                        </>
                        )}
                    </div>
                  </div>
                  <div className="extra">
                    <span className="location">
                      Location: {entry.location || "N/A"}
                    </span>
                    <span className="confidence">
                      Confidence:{" "}
                      {entry.confidence_score
                        ? `${(entry.confidence_score * 100).toFixed(0)}%`
                        : "N/A"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
