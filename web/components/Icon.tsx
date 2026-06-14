type Props = {
  name: string;
  className?: string;
  fill?: boolean;
  style?: React.CSSProperties;
};

export default function Icon({ name, className = "", fill, style }: Props) {
  const cls = `ic${fill ? " fill" : ""}${className ? " " + className : ""}`;
  return (
    <svg className={cls} style={style}>
      <use href={`#${name}`} />
    </svg>
  );
}
