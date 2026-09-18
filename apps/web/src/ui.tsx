import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  LoaderCircle,
  X,
} from "lucide-react";
import { ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissible?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && dismissible && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal ${wide ? "modal-wide" : ""}`}
          onEscapeKeyDown={(event) => !dismissible && event.preventDefault()}
          onPointerDownOutside={(event) => !dismissible && event.preventDefault()}
        >
          <header className="modal-head">
            <div>
              <span className="overline">Formulario</span>
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button modal-close" aria-label="Cerrar" disabled={!dismissible}>
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div className="modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmModal({
  title,
  detail,
  action,
  onClose,
  danger = false,
}: {
  title: string;
  detail: string;
  action: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className={`confirm-message ${danger ? "is-danger" : ""}`}>
        <span>
          <AlertTriangle size={20} />
        </span>
        <p>{detail}</p>
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Cancelar
        </button>
        <button
          className={`button ${danger ? "danger" : "primary"}`}
          onClick={action}
        >
          Confirmar
        </button>
      </div>
    </Modal>
  );
}

export function Pagination({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        <b>{total}</b> registros · Página {page} de {Math.max(pages, 1)}
      </span>
      <div>
        <button
          className="icon-button"
          aria-label="Página anterior"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Página siguiente"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Inbox size={25} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner() {
  return (
    <div className="loading">
      <LoaderCircle size={19} /> Cargando información…
    </div>
  );
}
