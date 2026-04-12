import React from "react";
import { FaCamera } from "react-icons/fa";

export default function CameraCapture({ open, videoRef, streamRef, onClose, onCapture }) {
  if (!open) return null;
  return (
    <div className="reg-camera-overlay" onClick={onClose}>
      <div className="reg-camera-modal" onClick={(e) => e.stopPropagation()}>
        <div className="reg-camera-header">
          <h3 className="reg-modal-title">Take Photo</h3>
          <button type="button" className="reg-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="reg-camera-body">
          <video
            ref={(el) => {
              videoRef.current = el;
              if (el && streamRef.current) el.srcObject = streamRef.current;
            }}
            autoPlay
            playsInline
            muted
            className="reg-camera-video"
          />
        </div>
        <div className="reg-camera-actions">
          <button type="button" className="reg-btn reg-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="reg-btn reg-btn-primary" onClick={onCapture}>
            <FaCamera style={{ marginRight: 6 }} /> Capture
          </button>
        </div>
      </div>
    </div>
  );
}
