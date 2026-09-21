export default function PagePlaceholder({ title, note }) {
  return (
    <div className="card placeholder">
      <h2>{title}</h2>
      <p>{note ?? 'This section will be built next.'}</p>
    </div>
  )
}
