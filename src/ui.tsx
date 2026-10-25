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

/** Native dialogs trap focus; a new bodyKey resets scrolling when a workflow changes step. */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
  drawer = false,
  busy = false,
  bodyKey,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
  busy?: boolean;
  bodyKey?: string;
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
      <div key={bodyKey} className={drawer ? "drawer-body" : "modal-body"}>
        {children}
      </div>
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
