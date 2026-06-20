package main

import (
	"log"
	"net/http"
	"strings"
)

type server struct {
	es *elasticsearchService
}

func main() {
	s := newServer()
	log.Printf("Go backend listening on :5000")
	log.Fatal(http.ListenAndServe(":5000", s.routes()))
}

func newServer() *server {
	return &server{
		es: newElasticsearchService(env("ES_URL", "http://elastic1:9200"), env("ES_INDEX", "qiita-articles")),
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.health)
	mux.HandleFunc("/health/elasticsearch", s.elasticsearchHealth)
	mux.HandleFunc("/api/recent", s.recent)
	mux.HandleFunc("/api/search", s.search)
	mux.HandleFunc("/api/articles/", s.article)
	mux.HandleFunc("/api/articles", s.articles)
	mux.HandleFunc("/api/link-preview", s.linkPreview)
	return mux
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"status": "ok", "backend": "go"})
}

func (s *server) elasticsearchHealth(w http.ResponseWriter, r *http.Request) {
	status, payload := s.es.Health(r.Context())
	writeJSON(w, status, payload)
}

func (s *server) recent(w http.ResponseWriter, r *http.Request) {
	size := positiveInt(r.URL.Query().Get("size"), 10, 100)
	tag := strings.TrimSpace(r.URL.Query().Get("tag"))
	result, err := s.es.Recent(r.Context(), size, tag)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *server) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, 400, map[string]any{"error": "検索キーワード q を指定してください。"})
		return
	}
	page := positiveInt(r.URL.Query().Get("page"), 1, 0)
	size := positiveInt(r.URL.Query().Get("size"), 10, 100)
	result, err := s.es.Search(r.Context(), query, page, size)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *server) articles(w http.ResponseWriter, r *http.Request) {
	page := positiveInt(r.URL.Query().Get("page"), 1, 0)
	size := positiveInt(r.URL.Query().Get("size"), 20, 100)
	result, err := s.es.Articles(r.Context(), page, size)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *server) article(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/articles/")
	if id == "" {
		writeJSON(w, 404, map[string]any{"error": "Not found"})
		return
	}
	source, err := s.es.Article(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, source)
}

func (s *server) linkPreview(w http.ResponseWriter, r *http.Request) {
	result, err := fetchLinkPreview(r.Context(), strings.TrimSpace(r.URL.Query().Get("url")))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
