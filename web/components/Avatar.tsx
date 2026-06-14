type Props = {
  name: string;
  bg: string;
  fg: string;
  size?: number;
  fontSize?: number;
  className?: string;
};

export default function Avatar({ name, bg, fg, size = 36, fontSize, className = "" }: Props) {
  return (
    <div
      className={className}
      style={{
        background: bg,
        color: fg,
        width: size,
        height: size,
        fontSize: fontSize ?? Math.round(size * 0.36),
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {name[0]}
    </div>
  );
}
