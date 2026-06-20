FROM ruby:3.4-alpine

RUN gem install webrick --no-document
WORKDIR /app
COPY backend_ruby/server.rb .
RUN ruby -c server.rb

EXPOSE 5000
CMD ["ruby", "server.rb"]
