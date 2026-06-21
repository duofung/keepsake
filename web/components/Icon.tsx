type Props = {
  name: string;
  className?: string;
  fill?: boolean;
  style?: React.CSSProperties;
};

export default function Icon({ name, className = "", fill, style }: Props) {
  const cls = `ic${fill ? " fill" : ""}${className ? " " + className : ""}`;
  const svgStyle: React.CSSProperties = fill
    ? {
        width: "1em",
        height: "1em",
        fill: "currentColor",
        stroke: "none",
        flexShrink: 0,
        display: "block",
        ...style,
      }
    : {
        width: "1em",
        height: "1em",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.75,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        flexShrink: 0,
        display: "block",
        ...style,
      };

  return (
    <svg
      className={cls}
      width="1em"
      height="1em"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={fill ? undefined : 1.75}
      strokeLinecap={fill ? undefined : "round"}
      strokeLinejoin={fill ? undefined : "round"}
      style={svgStyle}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${name}`} />
    </svg>
  );
}
