require "cgi"
require "ipaddr"
require "net/http"
require "resolv"
require "uri"
require_relative "api_error"

class LinkPreviewService
  MAX_PREVIEW_BYTES = 1_000_000

  def fetch(raw_url)
    current = validate_public_url(raw_url)
    4.times do
      request = Net::HTTP::Get.new(current)
      request["User-Agent"] = "Mozilla/5.0 (compatible; QiitaSearchLinkPreview/1.0)"
      request["Accept"] = "text/html,application/xhtml+xml"
      response = Net::HTTP.start(
        current.host, current.port,
        use_ssl: current.scheme == "https",
        open_timeout: 3,
        read_timeout: 5
      ) { |http| http.request(request) }

      if response.is_a?(Net::HTTPRedirection) && response["location"]
        current = validate_public_url(URI.join(current.to_s, response["location"]).to_s)
        next
      end
      raise ApiError.new(502, "リンク先の情報を取得できませんでした。") unless response.is_a?(Net::HTTPSuccess)

      content_type = response["content-type"].to_s.downcase
      unless content_type.include?("text/html") || content_type.include?("application/xhtml+xml")
        raise ApiError.new(400, "HTMLページではないためプレビューできません。")
      end
      document = response.body.byteslice(0, MAX_PREVIEW_BYTES).to_s
      title = first_non_empty(meta(document, "property", "og:title"), title_tag(document), current.host)
      description = first_non_empty(meta(document, "property", "og:description"), meta(document, "name", "description"))
      image = absolute_http_url(meta(document, "property", "og:image"), current)
      site_name = first_non_empty(meta(document, "property", "og:site_name"), current.host)
      return {
        url: current.to_s,
        title: title.each_char.take(300).join,
        description: description.each_char.take(500).join,
        image: image,
        site_name: site_name.each_char.take(100).join
      }
    end
    raise ApiError.new(502, "リンク先の情報を取得できませんでした。")
  rescue SocketError
    raise ApiError.new(400, "リンク先のホストを解決できません。")
  rescue Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED
    raise ApiError.new(502, "リンク先の情報を取得できませんでした。")
  end

  private

  def validate_public_url(raw)
    uri = URI(raw)
    unless %w[http https].include?(uri.scheme) && uri.host
      raise ApiError.new(400, "http または https のURLを指定してください。")
    end
    raise ApiError.new(400, "認証情報を含むURLはプレビューできません。") if uri.user || uri.password

    addresses = Resolv.getaddresses(uri.host)
    raise ApiError.new(400, "リンク先のホストを解決できません。") if addresses.empty?
    addresses.each do |address|
      ip = IPAddr.new(address)
      unless ip.ipv4? || ip.ipv6?
        raise ApiError.new(400, "リンク先のホストを解決できません。")
      end
      if ip.private? || ip.loopback? || ip.link_local? || ip.to_s == "0.0.0.0" || ip.to_s == "::"
        raise ApiError.new(400, "ローカルネットワークのURLはプレビューできません。")
      end
    end
    uri
  rescue URI::InvalidURIError
    raise ApiError.new(400, "http または https のURLを指定してください。")
  end

  def meta(document, attribute, value)
    quoted = Regexp.escape(value)
    patterns = [
      /<meta[^>]+#{attribute}=["']#{quoted}["'][^>]+content=["']([^"']*)["'][^>]*>/im,
      /<meta[^>]+content=["']([^"']*)["'][^>]+#{attribute}=["']#{quoted}["'][^>]*>/im
    ]
    patterns.each do |pattern|
      match = document.match(pattern)
      return CGI.unescapeHTML(match[1]).strip if match
    end
    ""
  end

  def title_tag(document)
    match = document.match(/<title[^>]*>(.*?)<\/title>/im)
    match ? CGI.unescapeHTML(match[1].gsub(/<[^>]+>/, "")).strip : ""
  end

  def absolute_http_url(value, base)
    return "" if value.empty?
    resolved = URI.join(base.to_s, value)
    %w[http https].include?(resolved.scheme) ? resolved.to_s : ""
  rescue URI::InvalidURIError
    ""
  end

  def first_non_empty(*values)
    values.find { |value| !value.to_s.empty? }.to_s
  end
end
