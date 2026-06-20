package main

import (
	"context"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxPreviewBytes = 1_000_000

func fetchLinkPreview(ctx context.Context, rawURL string) (map[string]any, error) {
	target, err := validatePublicURL(rawURL)
	if err != nil {
		return nil, err
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
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	response, err := client.Do(req)
	if err != nil {
		return nil, &apiError{502, "リンク先の情報を取得できませんでした。"}
	}
	defer response.Body.Close()
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "application/xhtml+xml") {
		return nil, &apiError{400, "HTMLページではないためプレビューできません。"}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPreviewBytes))
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &apiError{502, "リンク先の情報を取得できませんでした。"}
	}
	document := string(data)
	finalURL := response.Request.URL
	title := firstNonEmpty(metaContent(document, "property", "og:title"), titleContent(document), finalURL.Hostname())
	description := firstNonEmpty(metaContent(document, "property", "og:description"), metaContent(document, "name", "description"))
	image := absoluteHTTPURL(metaContent(document, "property", "og:image"), finalURL)
	siteName := firstNonEmpty(metaContent(document, "property", "og:site_name"), finalURL.Hostname())
	return map[string]any{
		"url": finalURL.String(), "title": truncate(title, 300), "description": truncate(description, 500),
		"image": image, "site_name": truncate(siteName, 100),
	}, nil
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
