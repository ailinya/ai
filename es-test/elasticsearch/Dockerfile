# Elastic 官方镜像（docker.elastic.co），避免 Docker Hub 的 library/elasticsearch 重打包版
# 在部分环境下出现 exec /bin/tini: exec format error
# 请将本机 elasticsearch-analysis-ik-8.17.0.zip 与本 Dockerfile 同目录后再 build
FROM docker.elastic.co/elasticsearch/elasticsearch:8.17.0

USER 0

# 使用本机 zip，避免镜像内 Java HTTPS / trust store 问题；解压到 plugins 与 plugin install 等效
COPY elasticsearch-analysis-ik-8.17.0.zip /tmp/analysis-ik.zip

RUN mkdir -p /usr/share/elasticsearch/plugins/analysis-ik \
    && unzip -qo /tmp/analysis-ik.zip -d /usr/share/elasticsearch/plugins/analysis-ik \
    && rm -f /tmp/analysis-ik.zip \
    && chown -R 1000:0 /usr/share/elasticsearch/plugins/analysis-ik

USER 1000:0
