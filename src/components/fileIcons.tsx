import { fileIconFor } from "./fileIconSpec";

export function FileTypeIcon({ name }: { name: string }) {
  const spec = fileIconFor(name);
  const fontSize = spec.glyph.length >= 3 ? 6.5 : spec.glyph.length === 2 ? 8 : 11;
  return (
    <svg className="file-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight="700"
        fontFamily="'Segoe UI', system-ui, sans-serif"
        fill={spec.color}
      >
        {spec.glyph}
      </text>
    </svg>
  );
}
