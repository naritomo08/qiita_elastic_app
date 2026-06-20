package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var esHTTPClient = &http.Client{Timeout: 10 * time.Second}

type elasticsearchService struct {
	esURL string
	index string
}

func newElasticsearchService(esURL, index string) *elasticsearchService {
	return &elasticsearchService{
		esURL: strings.TrimRight(esURL, "/"),
		index: index,
	}
}

func (s *elasticsearchService) Health(ctx context.Context) (int, map[string]any) {
	startedAt := time.Now()
	var response map[string]any
	status, err := requestJSON(ctx, http.MethodGet, s.esURL, nil, &response)
	payload := map[string]any{
		"service": "elasticsearch", "checked_by": "go",
		"latency_ms": time.Since(startedAt).Milliseconds(),
	}
	if err != nil || status != 200 {
		payload["status"] = "error"
		payload["error"] = "Elasticsearch に接続できませんでした。"
		return 503, payload
	}
	payload["status"] = "ok"
	payload["cluster_name"] = response["cluster_name"]
	if version, ok := response["version"].(map[string]any); ok {
		payload["version"] = version["number"]
	} else {
		payload["version"] = ""
	}
	return 200, payload
}

func (s *elasticsearchService) Recent(ctx context.Context, size int, tag string) (map[string]any, error) {
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
	response, err := s.esSearch(ctx, body)
	if err != nil {
		return nil, err
	}
	_, results, err := parseHits(response)
	if err != nil {
		return nil, err
	}
	return map[string]any{"total": len(results), "results": results}, nil
}

func (s *elasticsearchService) Search(ctx context.Context, query string, page, size int) (map[string]any, error) {
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
	return s.searchResponse(ctx, body, page, size)
}

func (s *elasticsearchService) Articles(ctx context.Context, page, size int) (map[string]any, error) {
	body := map[string]any{
		"query": map[string]any{"match_all": map[string]any{}},
		"sort":  []any{map[string]any{"created_at": map[string]any{"order": "desc", "unmapped_type": "date"}}},
		"from":  (page - 1) * size, "size": size,
	}
	return s.searchResponse(ctx, body, page, size)
}

func (s *elasticsearchService) searchResponse(ctx context.Context, body map[string]any, page, size int) (map[string]any, error) {
	response, err := s.esSearch(ctx, body)
	if err != nil {
		return nil, err
	}
	total, results, err := parseHits(response)
	if err != nil {
		return nil, err
	}
	return map[string]any{"total": total, "page": page, "size": size, "results": results}, nil
}

func (s *elasticsearchService) Article(ctx context.Context, id string) (map[string]any, error) {
	endpoint := fmt.Sprintf("%s/%s/_doc/%s", s.esURL, url.PathEscape(s.index), url.PathEscape(id))
	var response map[string]any
	status, err := requestJSON(ctx, http.MethodGet, endpoint, nil, &response)
	if err != nil {
		return nil, &apiError{503, "Elasticsearch に接続できませんでした。接続先を確認してください。"}
	}
	if status == 404 {
		if errorType(response) == "index_not_found_exception" {
			return nil, &apiError{404, fmt.Sprintf("Elasticsearch インデックス「%s」が見つかりません。", s.index)}
		}
		return nil, &apiError{404, "指定された記事は見つかりませんでした。"}
	}
	if status != 200 {
		return nil, &apiError{mapESStatus(status), "Elasticsearch から記事を取得できませんでした。"}
	}
	source, ok := response["_source"].(map[string]any)
	if !ok {
		return nil, &apiError{502, "Elasticsearch から想定外の記事データが返されました。"}
	}
	source["id"] = response["_id"]
	return source, nil
}

func (s *elasticsearchService) esSearch(ctx context.Context, body map[string]any) (map[string]any, error) {
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
	response, err := esHTTPClient.Do(req)
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
