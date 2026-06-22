package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type ClaimHandler struct {
	db *pgxpool.Pool
}

func NewClaimHandler(db *pgxpool.Pool) *ClaimHandler {
	return &ClaimHandler{db: db}
}

const claimSelectCols = `
	c.id, c.user_id, u.email, COALESCE(u.full_name,'') AS full_name,
	c.org_id, c.title, c.description, c.amount_cents, c.status,
	c.documents, c.employer_note, c.reviewed_at, c.reviewed_by, c.created_at
`

func scanClaim(row interface{ Scan(...any) error }) (*models.Claim, error) {
	var c models.Claim
	var docs []byte
	err := row.Scan(
		&c.ID, &c.UserID, &c.UserEmail, &c.UserFullName,
		&c.OrgID, &c.Title, &c.Description, &c.AmountCents, &c.Status,
		&docs, &c.EmployerNote, &c.ReviewedAt, &c.ReviewedBy, &c.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	c.Documents = []models.ClaimDocument{}
	if len(docs) > 0 {
		_ = json.Unmarshal(docs, &c.Documents)
	}
	return &c, nil
}

// List returns claims scoped to the caller:
//   - employee: their own (latest first)
//   - employer/god: all in their org, pending first
func (h *ClaimHandler) List(w http.ResponseWriter, r *http.Request) {
	var (
		query string
		args  []any
	)

	if mw.Role(r) == models.RoleEmployee {
		query = `SELECT ` + claimSelectCols + `
		FROM claims c JOIN users u ON u.id = c.user_id
		WHERE c.user_id = $1
		ORDER BY c.created_at DESC
		LIMIT 200`
		args = []any{mw.UserID(r)}
	} else if mw.IsGod(r) {
		query = `SELECT ` + claimSelectCols + `
		FROM claims c JOIN users u ON u.id = c.user_id
		ORDER BY (c.status = 'pending') DESC, c.created_at DESC
		LIMIT 500`
	} else {
		query = `SELECT ` + claimSelectCols + `
		FROM claims c JOIN users u ON u.id = c.user_id
		WHERE c.org_id = $1
		ORDER BY (c.status = 'pending') DESC, c.created_at DESC
		LIMIT 500`
		args = []any{mw.OrgID(r)}
	}

	rows, err := h.db.Query(r.Context(), query, args...)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	result := []models.Claim{}
	for rows.Next() {
		c, err := scanClaim(rows)
		if err != nil {
			continue
		}
		result = append(result, *c)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// Create files a new pending claim for the signed-in employee.
// Body: {title, description?, amount_cents, documents:[{name,url,content_type}]}
func (h *ClaimHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	orgID := mw.OrgID(r)
	if orgID == "" {
		http.Error(w, "your account is not part of an organization", http.StatusForbidden)
		return
	}

	var req struct {
		Title       string                 `json:"title"`
		Description *string                `json:"description"`
		AmountCents int64                  `json:"amount_cents"`
		Documents   []models.ClaimDocument `json:"documents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		http.Error(w, "title required", http.StatusBadRequest)
		return
	}
	if req.AmountCents < 0 {
		http.Error(w, "amount must be non-negative", http.StatusBadRequest)
		return
	}
	if req.Documents == nil {
		req.Documents = []models.ClaimDocument{}
	}
	docs, err := json.Marshal(req.Documents)
	if err != nil {
		http.Error(w, "invalid documents", http.StatusBadRequest)
		return
	}

	var id uuid.UUID
	err = h.db.QueryRow(r.Context(), `
		INSERT INTO claims (user_id, org_id, title, description, amount_cents, documents)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`, userID, orgID, req.Title, req.Description, req.AmountCents, docs).Scan(&id)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	c, err := scanClaim(h.db.QueryRow(r.Context(),
		`SELECT `+claimSelectCols+`
		 FROM claims c JOIN users u ON u.id = c.user_id
		 WHERE c.id = $1`, id))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(c)
}

// Delete removes the caller's own claim while it is still pending.
func (h *ClaimHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.db.Exec(r.Context(),
		`DELETE FROM claims WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
		id, mw.UserID(r))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "claim not found or already reviewed", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Approve transitions a pending claim to approved (employer/god only).
// Optional body: {"employer_note": "..."}
func (h *ClaimHandler) Approve(w http.ResponseWriter, r *http.Request) {
	h.review(w, r, "approved")
}

// Reject transitions a pending claim to rejected (employer/god only).
// Body: {"employer_note": "..."}
func (h *ClaimHandler) Reject(w http.ResponseWriter, r *http.Request) {
	h.review(w, r, "rejected")
}

func (h *ClaimHandler) review(w http.ResponseWriter, r *http.Request, status string) {
	id := chi.URLParam(r, "id")
	reviewerID := mw.UserID(r)

	var req struct {
		EmployerNote *string `json:"employer_note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	query := `
		UPDATE claims
		SET status = $2, reviewed_at = NOW(), reviewed_by = $3, employer_note = $4
		WHERE id = $1 AND status = 'pending'`
	args := []any{id, status, reviewerID, req.EmployerNote}
	if !mw.IsGod(r) {
		query += ` AND org_id = $5`
		args = append(args, mw.OrgID(r))
	}

	tag, err := h.db.Exec(r.Context(), query, args...)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "claim not found or already reviewed", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
