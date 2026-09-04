import { ReactNode, useEffect } from 'react';

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-head"><div><span className="overline">Formulario</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar">×</button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

export function ConfirmModal({ title, detail, action, onClose, danger = false }: { title: string; detail: string; action: () => void; onClose: () => void; danger?: boolean }) {
  return <Modal title={title} onClose={onClose}><p className="muted">{detail}</p><div className="modal-actions"><button className="button secondary" onClick={onClose}>Cancelar</button><button className={`button ${danger ? 'danger' : ''}`} onClick={action}>Confirmar</button></div></Modal>;
}

export function Pagination({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  return <div className="pagination"><span>{total} registros · Página {page} de {pages}</span><div><button className="icon-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button><button className="icon-button" disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button></div></div>;
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><div className="empty-mark">OA</div><h3>{title}</h3><p>{detail}</p></div>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }

export function Spinner() { return <div className="loading"><i /> Cargando información…</div>; }
