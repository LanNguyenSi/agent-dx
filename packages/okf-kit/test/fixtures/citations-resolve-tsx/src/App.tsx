// @ts-nocheck
import { useState } from "react";

export function Login({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="login">
        <button
          onClick={() => {
            setBusy(true);
            onDone();
          }}
        />
      </div>
    </>
  );
}

function Panel({ items }: { items: string[] }) {
  return (
    <div>
      {items.map((item) => (
        <span key={item}>
          {item}
        </span>
      ))}
      {items.length === 0 && (
        <em>nothing</em>
      )}
    </div>
  );
}

export const needle = "marker for anchored citations";
