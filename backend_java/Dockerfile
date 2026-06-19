FROM maven:3.9-eclipse-temurin-21-alpine AS builder

WORKDIR /src
COPY backend_java/pom.xml .
RUN mvn -q dependency:go-offline
COPY backend_java/src ./src
RUN mvn -q package

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY --from=builder /src/target/server.jar /app/server.jar

EXPOSE 5023
CMD ["java", "-jar", "/app/server.jar"]
