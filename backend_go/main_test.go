package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthAndValidation(t *testing.T) {
	s := newServer()
	handler := s.routes()

	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	request.Header.Set("Origin", "http://localhost:8082")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 || response.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatalf("unexpected health response: %d", response.Code)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/search", nil))
	if response.Code != 400 {
		t.Fatalf("search without q returned %d", response.Code)
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/link-preview?url=http://127.0.0.1/private", nil))
	if response.Code != 400 {
		t.Fatalf("local preview returned %d", response.Code)
	}
}
