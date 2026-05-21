"use client";

import { useState, useEffect, useCallback } from "react";
import {
  PlusIcon,
  Pencil,
  Trash2,
  RotateCcw,
  Check,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getFaqData,
  setFaqData,
  resetFaqData,
  loadFaqData,
} from "@/lib/faq-matcher";
import type { FaqEntry, FaqData } from "@/lib/faq-matcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// EntryForm — inline add/edit form
// ---------------------------------------------------------------------------

interface EntryFormProps {
  draft: Partial<FaqEntry>;
  isNew?: boolean;
  onChange: (patch: Partial<FaqEntry>) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function EntryForm({ draft, isNew = false, onChange, onCommit, onCancel }: EntryFormProps) {
  // Keep the keywords field as a raw string in local state so the user can
  // freely type commas and spaces without the value being rewritten mid-input.
  // We only parse it into an array on blur (or when committing).
  const [keywordsRaw, setKeywordsRaw] = useState(() =>
    (draft.keywords ?? []).join(", "),
  );

  const flushKeywords = (raw: string) => {
    onChange({
      keywords: raw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    });
  };

  const valid = (draft.question ?? "").trim().length > 0 && (draft.answer ?? "").trim().length > 0;

  return (
    <div className="rounded-lg border border-primary/40 bg-muted/40 p-4 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {isNew ? "New Entry" : "Edit Entry"}
      </p>
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Question</label>
        <Input
          autoFocus
          placeholder="What is …?"
          value={draft.question ?? ""}
          onChange={(e) => onChange({ question: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">
          Keywords{" "}
          <span className="font-normal text-muted-foreground">(comma-separated)</span>
        </label>
        <Input
          placeholder="cost, price, free, …"
          value={keywordsRaw}
          onChange={(e) => setKeywordsRaw(e.target.value)}
          onBlur={(e) => flushKeywords(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">Answer</label>
        <textarea
          className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-y"
          placeholder="The full answer the model will use to respond…"
          value={draft.answer ?? ""}
          onChange={(e) => onChange({ answer: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={() => { flushKeywords(keywordsRaw); onCommit(); }} disabled={!valid}>
          <Check className="size-3.5" /> Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntryCard — read-only display with edit/delete controls
// ---------------------------------------------------------------------------

interface EntryCardProps {
  entry: FaqEntry;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}

function EntryCard({
  entry,
  confirmingDelete,
  onEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border bg-card p-3 space-y-1">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          className="flex-1 text-left text-sm font-medium leading-snug hover:text-primary transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="mr-1">{entry.question}</span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-xs" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onEdit} title="Edit">
            <Pencil className="size-3.5" />
          </Button>
          {confirmingDelete ? (
            <>
              <Button variant="destructive" size="xs" onClick={onDeleteConfirm}>
                Delete
              </Button>
              <Button variant="ghost" size="xs" onClick={onDeleteCancel}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="icon-xs" onClick={onDeleteRequest} title="Delete">
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {entry.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.keywords.map((kw) => (
            <span
              key={kw}
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {kw}
            </span>
          ))}
        </div>
      )}

      {expanded && (
        <p className="text-sm text-muted-foreground leading-relaxed pt-1 border-t mt-2">
          {entry.answer}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FaqBuilder — main exported dialog
// ---------------------------------------------------------------------------

interface FaqBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FaqBuilder({ open, onOpenChange }: FaqBuilderProps) {
  const [entries, setEntries] = useState<FaqEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState<Partial<FaqEntry>>({});
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // Sync entries from in-memory FAQ data when dialog opens
  useEffect(() => {
    if (!open) return;
    loadFaqData().then(() => {
      setEntries(getFaqData()?.faq ?? []);
      setEditingId(null);
      setIsAdding(false);
      setDeleteConfirmId(null);
      setDraft({});
    });
  }, [open]);

  const persist = useCallback(
    (updated: FaqEntry[]) => {
      const existing = getFaqData();
      const newData: FaqData = {
        faq: updated,
        followUpTopics: existing?.followUpTopics ?? [],
      };
      setFaqData(newData);
      setEntries(updated);
    },
    [],
  );

  // ---- Add ----
  const startAdd = () => {
    setIsAdding(true);
    setEditingId(null);
    setDraft({ question: "", keywords: [], answer: "" });
  };

  // ---- Edit ----
  const startEdit = (entry: FaqEntry) => {
    setIsAdding(false);
    setEditingId(entry.id);
    setDraft({ ...entry });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setIsAdding(false);
    setDraft({});
  };

  const commitEdit = () => {
    const question = (draft.question ?? "").trim();
    const answer = (draft.answer ?? "").trim();
    if (!question || !answer) return;

    if (isAdding) {
      const baseId = slugify(question) || `entry-${Date.now()}`;
      const id = entries.some((e) => e.id === baseId) ? `${baseId}-${Date.now()}` : baseId;
      const newEntry: FaqEntry = { id, question, keywords: draft.keywords ?? [], answer };
      persist([...entries, newEntry]);
    } else if (editingId) {
      persist(
        entries.map((e) =>
          e.id === editingId ? { ...e, question, keywords: draft.keywords ?? [], answer } : e,
        ),
      );
    }
    cancelEdit();
  };

  // ---- Delete ----
  const deleteEntry = (id: string) => {
    persist(entries.filter((e) => e.id !== id));
    setDeleteConfirmId(null);
  };

  // ---- Reset ----
  const handleReset = async () => {
    setResetting(true);
    try {
      const fresh = await resetFaqData();
      setEntries(fresh?.faq ?? []);
      setEditingId(null);
      setIsAdding(false);
      setDraft({});
    } finally {
      setResetting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col max-w-2xl max-h-[85vh] overflow-hidden p-0">
        <DialogDescription className="sr-only">
          Manage your knowledge entries — add, edit, or delete questions and answers.
        </DialogDescription>
        {/* Header with Add Entry button */}
        <div className="px-6 pt-6 pb-4 border-b shrink-0 flex items-start justify-between gap-4">
          <div>
            <DialogTitle>Totem Builder</DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {entries.length} entr{entries.length === 1 ? "y" : "ies"} · saved to your browser automatically
            </p>
          </div>
          <Button
            size="sm"
            onClick={startAdd}
            disabled={isAdding || !!editingId}
            className="shrink-0 mt-0.5"
          >
            <PlusIcon className="size-3.5" /> Add Entry
          </Button>
        </div>

        {/* Scrollable entry list — min-h-0 lets the flex child shrink so overflow-y-auto works */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-2">
          {entries.length === 0 && !isAdding && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No entries yet. Click <strong>Add Entry</strong> to get started.
            </p>
          )}

          {entries.map((entry) =>
            editingId === entry.id ? (
              <EntryForm
                key={entry.id}
                draft={draft}
                onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                onCommit={commitEdit}
                onCancel={cancelEdit}
              />
            ) : (
              <EntryCard
                key={entry.id}
                entry={entry}
                confirmingDelete={deleteConfirmId === entry.id}
                onEdit={() => startEdit(entry)}
                onDeleteRequest={() => setDeleteConfirmId(entry.id)}
                onDeleteConfirm={() => deleteEntry(entry.id)}
                onDeleteCancel={() => setDeleteConfirmId(null)}
              />
            ),
          )}

          {isAdding && (
            <EntryForm
              draft={draft}
              isNew
              onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              onCommit={commitEdit}
              onCancel={cancelEdit}
            />
          )}
        </div>

        <div className="flex items-center px-6 py-3 border-t shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={resetting || isAdding || !!editingId}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-3.5" />
            {resetting ? "Resetting…" : "Reset to defaults"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
