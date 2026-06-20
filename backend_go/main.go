package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxPreviewBytes = 1_000_000

var httpClient = &http.Client{Timeout: 10 * time.Second}

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return e.Message }

type server struct {
	esURL string
	index string
}

func main() {
	s := newServer()
	log.Printf("Go backend listening on :5000")
	log.Fatal(http.ListenAndServe(":5000", s.routes()))
}

func newServer() *server {
	return &server{
		esURL: strings.TrimRight(env("ES_URL", "http://elastic1:9200"), "/"),
		index: env("ES_INDEX", "qiita-articles"),
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
	startedAt := time.Now()
	var response map[string]any
	status, err := requestJSON(r.Context(), http.MethodGet, s.esURL, nil, &response)
	payload := map[string]any{
		"service": "elasticsearch", "checked_by": "go",
		"latency_ms": time.Since(startedAt).Milliseconds(),
	}
	if err != nil || status != 200 {
		payload["status"] = "error"
		payload["error"] = "Elasticsearch に接続できませんでした。"
		writeJSON(w, 503, payload)
		return
	}
	payload["status"] = "ok"
	payload["cluster_name"] = response["cluster_name"]
	if version, ok := response["version"].(map[string]any); ok {
		payload["version"] = version["number"]
	} else {
		payload["version"] = ""
	}
	writeJSON(w, 200, payload)
}

func (s *server) recent(w http.ResponseWriter, r *http.Request) {
	size := positiveInt(r.URL.Query().Get("size"), 10, 100)
	tag := strings.TrimSpace(r.URL.Query().Get("tag"))
	query := map[string]any{"match_all": map[string]any{}}
	if tag != "" {
		query = map[string]any{"bool": map[string]any{
			"should": []any{
				map[string]any{"term": map[string]any{"tags.keyword": tag}},
				map[string]any{"match_phrase": map[string]any{"tags": tag}},
			},
			"minimum_should_match": 1,
		}}
	}
	sortField := "updated_at"
	if tag != "" {
		sortField = "created_at"
	}
	body := map[string]any{
		"query": query,
		"sort":  []any{map[string]any{sortField: map[string]any{"order": "desc", "unmapped_type": "date"}}},
		"size":  size,
	}
	response, err := s.esSearch(r.Context(), body)
	if err != nil {
		writeError(w, err)
		return
	}
	_, results, err := parseHits(response)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"total": len(results), "results": results})
}

func (s *server) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, 400, map[string]any{"error": "検索キーワード q を指定してください。"})
		return
	}
	page := positiveInt(r.URL.Query().Get("page"), 1, 0)
	size := positiveInt(r.URL.Query().Get("size"), 10, 100)
	body := map[string]any{
		"query": map[string]any{"multi_match": map[string]any{
			"query": query, "fields": []string{"title^3", "body", "tags^2"},
		}},
		"highlight": map[string]any{
			"pre_tags": []string{"<mark>"}, "post_tags": []string{"</mark>"},
			"fields": map[string]any{
				"title": map[string]any{},
				"body":  map[string]any{"fragment_size": 160, "number_of_fragments": 3},
			},
		},
		"from": (page - 1) * size, "size": size,
	}
	s.searchResponse(w, r, body, page, size)
}

func (s *server) articles(w http.ResponseWriter, r *http.Request) {
	page := positiveInt(r.URL.Query().Get("page"), 1, 0)
	size := positiveInt(r.URL.Query().Get("size"), 20, 100)
	body := map[string]any{
		"query": map[string]any{"match_all": map[string]any{}},
		"sort":  []any{map[string]any{"created_at": map[string]any{"order": "desc", "unmapped_type": "date"}}},
		"from":  (page - 1) * size, "size": size,
	}
	s.searchResponse(w, r, body, page, size)
}

func (s *server) searchResponse(w http.ResponseWriter, r *http.Request, body map[string]any, page, size int) {
	response, err := s.esSearch(r.Context(), body)
	if err != nil {
		writeError(w, err)
		return
	}
	total, results, err := parseHits(response)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"total": total, "page": page, "size": size, "results": results})
}

func (s *server) article(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/articles/")
	if id == "" {
		writeJSON(w, 404, map[string]any{"error": "Not found"})
		return
	}
	endpoint := fmt.Sprintf("%s/%s/_doc/%s", s.esURL, url.PathEscape(s.index), url.PathEscape(id))
	var response map[string]any
	status, err := requestJSON(r.Context(), http.MethodGet, endpoint, nil, &response)
	if err != nil {
		writeError(w, &apiError{503, "Elasticsearch に接続できませんでした。接続先を確認してください。"})
		return
	}
	if status == 404 {
		if errorType(response) == "index_not_found_exception" {
			writeError(w, &apiError{404, fmt.Sprintf("Elasticsearch インデックス「%s」が見つかりません。", s.index)})
		} else {
			writeError(w, &apiError{404, "指定された記事は見つかりませんでした。"})
		}
		return
	}
	if status != 200 {
		writeError(w, &apiError{mapESStatus(status), "Elasticsearch から記事を取得できませんでした。"})
		return
	}
	source, ok := response["_source"].(map[string]any)
	if !ok {
		writeError(w, &apiError{502, "Elasticsearch から想定外の記事データが返されました。"})
		return
	}
	source["id"] = response["_id"]
	writeJSON(w, 200, source)
}

func (s *server) esSearch(ctx context.Context, body map[string]any) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s/%s/_search", s.esURL, url.PathEscape(s.index))
	var response map[string]any
	status, err := requestJSON(ctx, http.MethodPost, endpoint, body, &response)
	if err != nil {
		return nil, &apiError{503, "Elasticsearch に接続できませんでした。接続先を確認してください。"}
	}
	if status == 404 && errorType(response) == "index_not_found_exception" {
		return nil, &apiError{404, fmt.Sprintf("Elasticsearch インデックス「%s」が見つかりません。", s.index)}
	}
	if status != 200 {
		return nil, &apiError{mapESStatus(status), "Elasticsearch で検索を実行できませんでした。"}
	}
	return response, nil
}

func parseHits(response map[string]any) (int, []map[string]any, error) {
	hits, ok := response["hits"].(map[string]any)
	if !ok {
		return 0, nil, &apiError{502, "Elasticsearch から想定外の検索結果が返されました。"}
	}
	total := 0
	switch value := hits["total"].(type) {
	case float64:
		total = int(value)
	case map[string]any:
		if number, ok := value["value"].(float64); ok {
			total = int(number)
		}
	default:
		return 0, nil, &apiError{502, "Elasticsearch から想定外の検索結果が返されました。"}
	}
	rawHits, ok := hits["hits"].([]any)
	if !ok {
		return 0, nil, &apiError{502, "Elasticsearch から想定外の検索結果が返されました。"}
	}
	results := make([]map[string]any, 0, len(rawHits))
	for _, item := range rawHits {
		hit, ok := item.(map[string]any)
		if !ok {
			return 0, nil, &apiError{502, "Elasticsearch から想定外の検索結果が返されました。"}
		}
		source, ok := hit["_source"].(map[string]any)
		if !ok {
			return 0, nil, &apiError{502, "Elasticsearch から想定外の検索結果が返されました。"}
		}
		result := make(map[string]any, len(source)+3)
		for key, value := range source {
			result[key] = value
		}
		result["id"] = hit["_id"]
		result["_score"] = hit["_score"]
		if highlight, ok := hit["highlight"]; ok {
			result["highlight"] = highlight
		} else {
			result["highlight"] = map[string]any{}
		}
		results = append(results, result)
	}
	return total, results, nil
}

func requestJSON(ctx context.Context, method, endpoint string, payload any, target any) (int, error) {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return 0, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 10_000_000))
	if err != nil {
		return response.StatusCode, err
	}
	if len(data) > 0 && json.Unmarshal(data, target) != nil {
		return response.StatusCode, errors.New("invalid JSON response")
	}
	return response.StatusCode, nil
}

func errorType(response map[string]any) string {
	if object, ok := response["error"].(map[string]any); ok {
		if value, ok := object["type"].(string); ok {
			return value
		}
	}
	return ""
}

func mapESStatus(status int) int {
	if status >= 500 {
		return 502
	}
	return 500
}

func (s *server) linkPreview(w http.ResponseWriter, r *http.Request) {
	target, err := validatePublicURL(strings.TrimSpace(r.URL.Query().Get("url")))
	if err != nil {
		writeError(w, err)
		return
	}
	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			_, validationError := validatePublicURL(req.URL.String())
			return validationError
		},
	}
	req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	response, err := client.Do(req)
	if err != nil {
		writeError(w, &apiError{502, "リンク先の情報を取得できませんでした。"})
		return
	}
	defer response.Body.Close()
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "application/xhtml+xml") {
		writeError(w, &apiError{400, "HTMLページではないためプレビューできません。"})
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPreviewBytes))
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, &apiError{502, "リンク先の情報を取得できませんでした。"})
		return
	}
	document := string(data)
	finalURL := response.Request.URL
	title := firstNonEmpty(metaContent(document, "property", "og:title"), titleContent(document), finalURL.Hostname())
	description := firstNonEmpty(metaContent(document, "property", "og:description"), metaContent(document, "name", "description"))
	image := absoluteHTTPURL(metaContent(document, "property", "og:image"), finalURL)
	siteName := firstNonEmpty(metaContent(document, "property", "og:site_name"), finalURL.Hostname())
	writeJSON(w, 200, map[string]any{
		"url": finalURL.String(), "title": truncate(title, 300), "description": truncate(description, 500),
		"image": image, "site_name": truncate(siteName, 100),
	})
}

func validatePublicURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return nil, &apiError{400, "http または https のURLを指定してください。"}
	}
	if parsed.User != nil {
		return nil, &apiError{400, "認証情報を含むURLはプレビューできません。"}
	}
	addresses, err := net.LookupIP(parsed.Hostname())
	if err != nil {
		return nil, &apiError{400, "リンク先のホストを解決できません。"}
	}
	for _, address := range addresses {
		if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
			return nil, &apiError{400, "ローカルネットワークのURLはプレビューできません。"}
		}
	}
	return parsed, nil
}

func metaContent(document, attribute, value string) string {
	quoted := regexp.QuoteMeta(value)
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?is)<meta[^>]+` + attribute + `=["']` + quoted + `["'][^>]+content=["']([^"']*)["'][^>]*>`),
		regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']*)["'][^>]+` + attribute + `=["']` + quoted + `["'][^>]*>`),
	}
	for _, pattern := range patterns {
		if match := pattern.FindStringSubmatch(document); len(match) == 2 {
			return strings.TrimSpace(html.UnescapeString(match[1]))
		}
	}
	return ""
}

func titleContent(document string) string {
	pattern := regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	if match := pattern.FindStringSubmatch(document); len(match) == 2 {
		return strings.TrimSpace(html.UnescapeString(match[1]))
	}
	return ""
}

func absoluteHTTPURL(value string, base *url.URL) string {
	if value == "" {
		return ""
	}
	reference, err := url.Parse(value)
	if err != nil {
		return ""
	}
	resolved := base.ResolveReference(reference)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return ""
	}
	return resolved.String()
}

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
