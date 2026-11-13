package services

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/atto-sound/user-service/internal/models"
)

// captureDeletions sends account_deletion_recorded to PostHog, one event per
// account, so the dashboard shows who deleted what without opening the DB.
// Best effort: the database row is the source of truth, this never blocks or
// fails a deletion. Same project key the telephony service falls back to.
func captureDeletions(records []models.AccountDeletion) {
	key := os.Getenv("POSTHOG_API_KEY")
	if key == "" {
		key = "phc_c7uYNqA3Y2DCrRHDhjUM0a4LWZDUViqdj1PCTUoNCrz"
	}
	host := strings.TrimRight(os.Getenv("POSTHOG_HOST"), "/")
	if host == "" {
		host = "https://us.i.posthog.com"
	}
	client := &http.Client{Timeout: 5 * time.Second}
	for _, r := range records {
		props := map[string]interface{}{
			"batch_id":             r.BatchID,
			"deleted_user_id":      r.DeletedUserID,
			"username":             r.Username,
			"role":                 r.Role,
			"is_managed_account":   r.IsManagedAccount,
			"representative_id":    r.RepresentativeID,
			"via":                  r.Via,
			"requested_by":         r.RequestedBy,
			"performed_by":         r.PerformedBy,
			"reason":               r.Reason,
			"actor_user_id":        r.ActorUserID,
			"included_as_linked":   r.IncludedAsLinked,
			"orphaned_creator_ids": r.OrphanedCreatorIDs,
			"left_orphans":         r.OrphanedCreatorIDs != "",
		}
		body, _ := json.Marshal(map[string]interface{}{
			"api_key":     key,
			"event":       "account_deletion_recorded",
			"distinct_id": "system-deletions",
			"properties":  props,
		})
		resp, err := client.Post(host+"/capture/", "application/json", bytes.NewReader(body))
		if err != nil {
			log.Printf("[USER] PostHog capture of deletion %d failed: %v", r.DeletedUserID, err)
			continue
		}
		resp.Body.Close()
	}
}
