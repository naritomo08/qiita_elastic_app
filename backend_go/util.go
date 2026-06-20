package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
)

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return e.Message }

func positiveInt(value string, fallback, maximum int) int {
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		number = fallback
	}
	if maximum > 0 && number > maximum {
		number = maximum
	}
	return number
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func truncate(value string, maximum int) string {
	runes := []rune(value)
	if len(runes) > maximum {
		return string(runes[:maximum])
	}
	return value
}

func writeError(w http.ResponseWriter, err error) {
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		apiErr = &apiError{500, "サーバー内部でエラーが発生しました。"}
	}
	writeJSON(w, apiErr.Status, map[string]any{"error": apiErr.Message})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
