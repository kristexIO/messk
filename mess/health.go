package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

func writePublicHealthReport(w http.ResponseWriter, r *http.Request, db *DB, hub *Hub, rdb *redis.Client) {
	writeHealthReport(w, r, db, hub, rdb, false)
}

func writeAdminHealthReport(w http.ResponseWriter, r *http.Request, db *DB, hub *Hub, rdb *redis.Client) {
	writeHealthReport(w, r, db, hub, rdb, true)
}

func writeHealthReport(w http.ResponseWriter, r *http.Request, db *DB, hub *Hub, rdb *redis.Client, includeStats bool) {
	healthCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	report, statusCode := collectHealthReport(healthCtx, db, hub, rdb, includeStats)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(report)
}

func collectHealthReport(ctx context.Context, db *DB, hub *Hub, rdb *redis.Client, includeStats bool) (map[string]any, int) {
	dbStatus := "disabled"
	var dbStats DBStats
	var dbStatsErr error
	if db != nil {
		dbStatus = "ok"
		if err := db.Ping(ctx); err != nil {
			dbStatus = "error"
		}
		if includeStats {
			dbStats, dbStatsErr = db.Stats(ctx)
			if dbStatsErr != nil && dbStatus == "ok" {
				dbStatus = "degraded"
			}
		}
	}

	redisStatus := "disabled"
	if rdb != nil {
		if err := rdb.Ping(ctx).Err(); err != nil {
			redisStatus = "error"
		} else {
			redisStatus = "ok"
		}
	}

	overallStatus := "ok"
	statusCode := http.StatusOK
	if dbStatus == "error" {
		overallStatus = "error"
		statusCode = http.StatusServiceUnavailable
	} else if dbStatus == "degraded" || redisStatus == "error" {
		overallStatus = "degraded"
	}

	report := map[string]any{
		"status": overallStatus,
		"version": map[string]string{
			"version": appVersion,
			"commit":  commitSHA,
			"builtAt": buildTime,
		},
		"services": map[string]string{
			"database": dbStatus,
			"cache":    "ok",
			"redis":    redisStatus,
		},
		"time": time.Now().UTC().Format(time.RFC3339),
	}
	if includeStats {
		report["stats"] = map[string]any{
			"database":                  dbStats,
			"databaseStatsError":        errorString(dbStatsErr),
			"hub":                       hub.Stats(),
			"relay":                     hub.RelayStats(time.Now().UTC()),
			"uploads":                   collectUploadStats(getUploadDir()),
			"operationalEvents":         defaultOperationalEventCounter.Snapshot(),
			"offlineDeliveryBatchLimit": offlineDeliveryBatchLimit,
		}
	}
	return report, statusCode
}
