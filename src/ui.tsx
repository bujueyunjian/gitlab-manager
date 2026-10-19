import { useEffect, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, LoaderCircle, X } from "lucide-react";

export function Button({
  children,
  variant = "",
  busy = false,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; busy?: boolean }) {
  return (
    <button {...props} disabled={disabled || busy} className={`btn ${variant} ${className}`}>
      {busy && <LoaderCircle className="spin" size={15} />}
      {children}
    </button>
  );
}

/** Native dialogs provide focus trapping and Escape behavior without a second UI framework. */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
  drawer = false,
  busy = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`${drawer ? "drawer" : "modal"} ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="modal-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className={drawer ? "drawer-body" : "modal-body"}>{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </dialog>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="hint error" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  );
}
export function Badge({ children, color = "gray" }: { children: ReactNode; color?: string }) {
  return <span className={`badge ${color}`}>{children}</span>;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
export function Loading({ children = "正在读取…" }: { children?: ReactNode }) {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={18} />
      {children}
    </div>
  );
}
export function OrbitDecoration() {
  return (
    <svg className="quantum-orbit" aria-hidden="true" viewBox="0 0 240 120">
      <ellipse cx="120" cy="60" rx="105" ry="30" transform="rotate(-15 120 60)" />
      <ellipse cx="120" cy="60" rx="82" ry="27" transform="rotate(25 120 60)" />
      <ellipse cx="120" cy="60" rx="45" ry="45" />
      <circle className="orbit-core" cx="120" cy="60" r="4" />
    </svg>
  );
}
