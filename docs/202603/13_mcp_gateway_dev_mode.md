---
title: MCP Server #3 Microsoft MCP Gatewayを開発モードで起動してCodexから使う
date: 2026-03-31 23:45:00
excerpt: Microsoft MCP Gateway を microk8s 上で開発モード起動し、sample adapter を登録して Codex から streamable HTTP MCP として接続するまでの手順と確認結果をまとめる
series: mcp-server
seriesOrder: 3
tags: mcp, codex, kubernetes, microk8s, microsoft, gateway, tutorial
---

## はじめに

この記事では、`Microsoft MCP Gateway` を開発モードで起動し、`Codex` から実際に接続して動作確認するところまでをまとめます。

これを試す背景として気になっていたのは次のあたりです。

- Microsoft MCP Gateway はローカルでも試せるのか
- `microk8s` 上で PoC できるのか
- Codex から `streamable HTTP` の MCP Server として使えるのか

結論からいうと、開発モードであれば `microk8s + Docker + .NET 8` でローカル PoC は十分可能でした。

一方で、試してみて見えてきた前提もあります。

- 開発モードでは Entra ID 連携は有効にならない
- Entra ID を公式どおり有効化するには `Production` モードが必要
- その場合は Cosmos DB 前提の構成に入る

なので、この記事では範囲を絞って、まずは Microsoft MCP Gateway を開発モードで立ち上げて Codex から使うところまでを扱います。

## 今回の構成

今回の構成は次の通りです。

```text
+--------+        +-------------------------+        +------------------+
| Codex  | -----> | Microsoft MCP Gateway   | -----> | mcp-example      |
| Client |  HTTP  | on microk8s             |        | sample adapter   |
+--------+        +-------------------------+        +------------------+
                        |
                        +---- redis
```

役割はざっくり次のように分かれます。

- `Codex`: MCP Client
- `Microsoft MCP Gateway`: adapter 管理 API と MCP endpoint を提供
- `toolgateway`: backend MCP のルーティングを担当
- `redis`: 開発モード用のストア
- `mcp-example`: 動作確認用の sample adapter

## 前提環境

今回使った前提は次の通りです。

- Ubuntu
- `microk8s`
- `Docker`
- `.NET 8 SDK`
- `Codex VSCode Extension`

## 1. Microsoft MCP Gateway を取得する

まずはソースを取得します。

```bash
git clone https://github.com/microsoft/mcp-gateway.git
cd mcp-gateway
```

ローカルデプロイは、このリポジトリに含まれている `deployment/k8s/local-deployment.yml` を使います。

## 2. ローカル registry を起動する

公式のローカル手順では `localhost:5000` の registry を使います。

```bash
docker run -d -p 5000:5000 --name registry registry:2.7
```

確認:

```bash
docker ps
curl http://localhost:5000/v2/_catalog
```

## 3. sample server をビルドして push する

動作確認用の `mcp-example` を先にビルドします。

```bash
docker build \
  -f sample-servers/mcp-example/Dockerfile \
  sample-servers/mcp-example \
  -t localhost:5000/mcp-example:1.0.0

docker push localhost:5000/mcp-example:1.0.0
```

## 4. Gateway 本体を build / publish する

次に `Microsoft MCP Gateway Service` と `Tool Gateway` をビルドします。

```bash
dotnet publish \
  dotnet/Microsoft.McpGateway.Service/src/Microsoft.McpGateway.Service.csproj \
  -c Release \
  /p:PublishProfile=localhost_5000.pubxml

dotnet publish \
  dotnet/Microsoft.McpGateway.Tools/src/Microsoft.McpGateway.Tools.csproj \
  -c Release \
  /p:PublishProfile=localhost_5000.pubxml
```

ここで build 後に、registry 側にイメージが見えていることを確認しておくと安心です。

```bash
curl http://localhost:5000/v2/_catalog
```

## 5. microk8s にデプロイする

manifest を適用します。

```bash
microk8s kubectl apply -f deployment/k8s/local-deployment.yml
microk8s kubectl get all -n adapter
```

正常に起動すると、次のような構成になります。

- `mcpgateway`
- `toolgateway`
- `redis`

いずれも `Running` になっていれば OK です。

## 6. arm64 環境では publish profile の修正が必要だった

今回いちばんハマったのがここでした。

ホスト環境は `aarch64 / arm64` だったのですが、公式の publish profile は `linux-x64` 前提になっていました。

その結果、Pod 起動時に次のエラーで落ちました。

```text
exec /usr/bin/dotnet: exec format error
```

実際に修正したのは次の 2 ファイルです。

- `dotnet/Microsoft.McpGateway.Service/src/Properties/PublishProfiles/localhost_5000.pubxml`
- `dotnet/Microsoft.McpGateway.Tools/src/Properties/PublishProfiles/localhost_5000.pubxml`

変更内容はどちらも同じで、

```xml
<RuntimeIdentifier>linux-x64</RuntimeIdentifier>
```

を

```xml
<RuntimeIdentifier>linux-arm64</RuntimeIdentifier>
```

へ変更しました。

この修正後に `dotnet publish` をやり直すことで、`microk8s` 上でも正常に起動できるようになりました。

もし `Raspberry Pi` 系や `arm64` サーバで試す場合は、かなり重要なポイントです。

## 7. port-forward で Gateway へ接続する

Gateway の service へ `port-forward` します。

```bash
microk8s kubectl port-forward -n adapter svc/mcpgateway-service 8000:8000
```

このコマンドは、Codex から使う間は起動し続ける必要があります。

別ターミナルで疎通確認します。

```bash
curl -i http://localhost:8000/
```

404 になりますが、`Kestrel` が応答していることを確認したかったので、これでGateway自体には到達できていることが確認できます。

## 8. sample adapter を登録する

`mcp-example` を adapter として登録します。

```bash
curl -X POST http://localhost:8000/adapters \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "mcp-example",
    "imageName": "mcp-example",
    "imageVersion": "1.0.0",
    "description": "test"
  }'
```

登録後は次で確認できます。

```bash
curl http://localhost:8000/adapters | jq .
microk8s kubectl get all -n adapter
```

実際には、`mcp-example` 用の StatefulSet / Service / Pod が追加され、次のような状態になりました。

- `pod/mcp-example-0` が `Running`
- `statefulset.apps/mcp-example` が `1/1`
- `service/mcp-example-service` が作成済み

ここまで来れば、Gateway 管理 API で adapter を登録し、Kubernetes 上に backend 実体を起動できていることが分かります。

## 9. Codex に Gateway endpoint を登録する

次に、Codex 側へ Gateway 経由の MCP endpoint を登録します。

sample adapter の endpoint は次です。

```text
http://127.0.0.1:8000/adapters/mcp-example/mcp
```

これを `codex mcp add` で登録します。

```bash
codex mcp add mcp-gateway-example \
  --url http://127.0.0.1:8000/adapters/mcp-example/mcp
```

確認:

```bash
codex mcp list
codex mcp get mcp-gateway-example
```

## 10. Codex からツールを呼んで確認する

Codex から接続すると、`mcp-example` に含まれている sample tool を利用できます。

今回確認できたのは次の tool です。

- `add(a: number, b: number)`: 2 つの数を足して返す

実際に `a=2, b=3` を渡したところ、結果として `5` が返ってきました。

つまり、今回の PoC では少なくとも次の経路が成立しています。

### 実際のテキスト
```text
==> input
mcp-gateway-example経由で使えるtoolを見せてもらえる？

<== outpud
`mcp-gateway-example` 経由で今使えるのはこれだけだよ〜！

- `add(a: number, b: number)`
  - 2つの数を足して返すサンプルツール

例: { "a": 2, "b": 3 }

返り値: { "result": 5 }

これは接続確認用のミニマムなデモMCPって感じだね 👀  
必要なら次に、実際にこの `add` を呼んで動作確認までやるよ！

==> input
add の実行をお願い！

<== output
動いた〜！

`mcp-gateway-example` の `add` に `{ "a": 2, "b": 3 }` を渡した結果、`5` が返ってきたよ！

つまり、このツールはこの環境から正常に呼べてるって見てよさそう！👀
```


## ここまでで分かったこと

今回の検証で見えたポイントは次の通りです。

- Microsoft MCP Gateway は `microk8s` 上でもローカル PoC できる
- `Codex` から `streamable HTTP MCP` として接続できる
- adapter 登録によって backend MCP server を Kubernetes 上に起動できる
- `arm64` 環境では publish profile の修正が必要になる場合がある

また、今回の範囲外として切り分けるべき点も見えました。

- `local-deployment.yml` は `Development` モード
- この状態では Entra ID 連携は有効ではない
- 公式どおりに Entra ID を有効化するには `Production` モードが必要
- `Production` モードでは Cosmos DB 前提の構成に入る

つまり、開発モードの Gateway PoC と、Identity Plane まで含めた認証連携 PoC は段階を分けて考えたほうがよいということです。

## まとめ

今回は、`Microsoft MCP Gateway` を開発モードで `microk8s` 上に立ち上げ、`mcp-example` adapter を登録し、`Codex` から実際に tool を呼び出すところまでを確認しました。

ポイントは次の通りです。

- `microk8s + Docker + .NET 8` でローカル PoC は十分可能
- `port-forward` した Gateway endpoint を `codex mcp add --url` で登録できる
- `mcp-example` の tool 実行まで通れば、Gateway PoC としてはかなり十分
- `arm64` 環境では `linux-arm64` への publish profile 修正が重要
- Entra ID 連携は別段階で考えるのが安全
