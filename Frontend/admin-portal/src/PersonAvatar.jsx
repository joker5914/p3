import { useState, useMemo } from "react";

function isSafeImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// Deterministic color palette for initials avatars
const AVATAR_COLORS = [
  "#0071e3", "#34c759", "#ff9f0a", "#ff6b35",
  "#af52de", "#5ac8fa", "#ff2d55", "#30b0c7",
];

function colorForName(name) {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function PersonAvatar({ name, photoUrl, size = 32 }) {
  const [imgFailed, setImgFailed] = useState(false);
  const safeUrl = useMemo(() => isSafeImageUrl(photoUrl) ? photoUrl : null, [photoUrl]);

  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (safeUrl && !imgFailed) {
    return (
      <img
        src={safeUrl}
        alt={name || ""}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
          display: "block",
        }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div
      aria-label={name || "Unknown"}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colorForName(name),
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.38),
        fontWeight: 700,
        flexShrink: 0,
        letterSpacing: "-0.3px",
        userSelect: "none",
      }}
    >
      {initials}
    </div>
  );
}
