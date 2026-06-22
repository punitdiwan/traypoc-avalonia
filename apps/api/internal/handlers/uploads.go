package handlers

import (
	"encoding/json"
	"net/http"
	"path"
	"strings"
	"time"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/spaces"
)

type UploadHandler struct {
	spaces *spaces.Client
}

func NewUploadHandler(s *spaces.Client) *UploadHandler { return &UploadHandler{spaces: s} }

type presignFile struct {
	// Key is the object path *under the caller's own prefix*, e.g.
	// "2026-06-15/20260615_120105.png". The server prepends the user id.
	Key         string `json:"key"`
	ContentType string `json:"content_type"`
}

type presignRequest struct {
	Files []presignFile `json:"files"`
}

type presignedUpload struct {
	Key       string            `json:"key"`
	PutURL    string            `json:"put_url"`
	PublicURL string            `json:"public_url"`
	Headers   map[string]string `json:"headers"`
}

// Presign issues short-lived presigned PUT URLs so the desktop can upload
// screenshots straight to Spaces without ever holding the bucket credentials.
// Every key is forced under the authenticated user's prefix, so one user can't
// write into another's path.
func (h *UploadHandler) Presign(w http.ResponseWriter, r *http.Request) {
	if h.spaces == nil {
		http.Error(w, "uploads not configured", http.StatusServiceUnavailable)
		return
	}
	userID := mw.UserID(r)

	var req presignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if len(req.Files) == 0 || len(req.Files) > 20 {
		http.Error(w, "files must contain 1..20 entries", http.StatusBadRequest)
		return
	}

	out := make([]presignedUpload, 0, len(req.Files))
	for _, f := range req.Files {
		// Normalize and reject path traversal; the key is then scoped to the user.
		rel := strings.TrimPrefix(path.Clean("/"+f.Key), "/")
		if rel == "" || rel == "." || strings.Contains(rel, "..") {
			http.Error(w, "invalid key", http.StatusBadRequest)
			return
		}
		// Tolerate a client that already prepended its own user id.
		rel = strings.TrimPrefix(rel, userID+"/")
		key := userID + "/" + rel

		ct := f.ContentType
		if ct == "" {
			ct = contentTypeForKey(rel)
		}

		put, public, err := h.spaces.PresignPut(r.Context(), key, ct, 15*time.Minute)
		if err != nil {
			http.Error(w, "presign error", http.StatusInternalServerError)
			return
		}
		out = append(out, presignedUpload{
			Key:       key,
			PutURL:    put,
			PublicURL: public,
			Headers:   map[string]string{"x-amz-acl": "public-read", "Content-Type": ct},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"uploads": out})
}

func contentTypeForKey(key string) string {
	k := strings.ToLower(key)
	switch {
	case strings.HasSuffix(k, ".png"):
		return "image/png"
	case strings.HasSuffix(k, ".pdf"):
		return "application/pdf"
	default:
		return "image/jpeg"
	}
}
