require "cgi"
require "json"
require "webrick"

require_relative "api_error"
require_relative "elasticsearch_service"
require_relative "link_preview_service"

class Backend
  def initialize
    @elasticsearch = ElasticsearchService.new(
      ENV.fetch("ES_URL", "http://elastic1:9200"),
      ENV.fetch("ES_INDEX", "qiita-articles")
    )
    @link_preview = LinkPreviewService.new
  end

  def call(request, response)
    payload, status = route(request)
    json(response, status, payload)
  rescue ApiError => error
    json(response, error.status, { error: error.message })
  rescue StandardError => error
    warn error.full_message
    json(response, 500, { error: "サーバー内部でエラーが発生しました。" })
  end

  private

  def route(request)
    case request.path
    when "/health"
      [{ status: "ok", backend: "ruby" }, 200]
    when "/health/elasticsearch"
      @elasticsearch.health
    when "/api/recent"
      size = positive_int(request.query["size"], 10, 100)
      tag = request.query["tag"].to_s.strip
      [@elasticsearch.recent(size, tag), 200]
    when "/api/search"
      query = request.query["q"].to_s.strip
      raise ApiError.new(400, "検索キーワード q を指定してください。") if query.empty?

      page = positive_int(request.query["page"], 1)
      size = positive_int(request.query["size"], 10, 100)
      [@elasticsearch.search(query, page, size), 200]
    when "/api/articles"
      page = positive_int(request.query["page"], 1)
      size = positive_int(request.query["size"], 20, 100)
      [@elasticsearch.articles(page, size), 200]
    when "/api/link-preview"
      [@link_preview.fetch(request.query["url"].to_s.strip), 200]
    else
      if request.path.start_with?("/api/articles/")
        [@elasticsearch.article(CGI.unescape(request.path.delete_prefix("/api/articles/"))), 200]
      else
        [{ error: "Not found" }, 404]
      end
    end
  end

  def json(response, status, payload)
    response.status = status
    response["Content-Type"] = "application/json; charset=utf-8"
    response.body = JSON.generate(payload)
  end

  def positive_int(value, default, maximum = nil)
    parsed = Integer(value || "", exception: false)
    parsed = default unless parsed&.positive?
    maximum ? [parsed, maximum].min : parsed
  end
end

backend = Backend.new
server = WEBrick::HTTPServer.new(
  Port: 5000,
  BindAddress: "0.0.0.0",
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::INFO)
)
server.mount_proc("/") { |request, response| backend.call(request, response) }
trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }
server.start
