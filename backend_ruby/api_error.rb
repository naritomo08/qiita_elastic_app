class ApiError < StandardError
  attr_reader :status

  def initialize(status, message)
    @status = status
    super(message)
  end
end
