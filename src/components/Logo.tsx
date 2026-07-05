// Brand mark: a filter funnel with a unicorn horn rising from its mouth and a
// single "unicorn" idea passing through the spout — ideas filtered down to the
// rare winner. Teal, matching the app accent. Pure SVG so it scales cleanly
// from the 20px nav mark to a favicon.
export function Logo({
  className = "h-6 w-6",
  title = "Unicorn Idea Filter",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* funnel */}
      <path
        d="M5 8.5 H27 L18.5 17.5 V25 H13.5 V17.5 Z"
        fill="#0d9488"
      />
      {/* unicorn horn rising from the funnel mouth */}
      <path d="M16 0.8 L18.2 9 H13.8 Z" fill="#2dd4bf" />
      {/* horn spiral stripes */}
      <path
        d="M14.6 6.5 L17.4 6.5 M15.1 4.4 L16.9 4.4"
        stroke="#0f766e"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
      {/* the filtered idea passing through the spout */}
      <circle cx="16" cy="28.5" r="1.9" fill="#2dd4bf" />
      {/* sparkle */}
      <path
        d="M23.5 4.2 L24 6 L25.8 6.5 L24 7 L23.5 8.8 L23 7 L21.2 6.5 L23 6 Z"
        fill="#5eead4"
      />
    </svg>
  );
}
