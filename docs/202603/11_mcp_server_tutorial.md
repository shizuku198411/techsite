---
title: MCP Server #1 Goで始める天気予報MCPサーバ構築
date: 2026-03-31 22:10:00
excerpt: MCP公式のGoチュートリアルをベースに、日本向けの天気APIと責務分離したGo構成で weather MCPサーバを step by step で構築し、Codex VS Code Extension から利用する
series: mcp-server
seriesOrder: 1
tags: mcp, go, codex, vscode, open-meteo, tutorial
---

## はじめに

この記事では、MCP 公式ドキュメントの Go 向けサーバ構築チュートリアルをベースに、天気予報を返す `weather` MCP サーバを step by step で作っていきます。

公式の Go チュートリアルはこちらです。

- [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server#go)

ただし、公式の weather サンプルは米国内向けの API を利用しているため、日本の座標をそのまま渡すと期待通りに動かないケースがあります。

そこで今回は、チュートリアルとして試しやすいことを優先して、次の方針で作ります。

- Go SDK を使って MCP サーバを構築する
- API は日本国内でも使いやすい `Open-Meteo` を利用する
- 実装は `config` / `api` / `tool` / `server` に分けて責務を整理する
- 最後に Codex VS Code Extension から接続して動作確認する

> 今回の記事で作成している実装コードは、次の GitHub リポジトリで公開しています。手元で試したい場合は、こちらを clone して進めるとそのまま再現しやすいです。  
> [Weather MCP server for JP Region](https://github.com/shizuku198411/Weather-MCP-Server-for-JP-Region)

## 今回作るもの

今回作る MCP サーバは、`get_forecast` というツールを 1 つ持つシンプルな構成です。

ツールに緯度経度を渡すと、Open-Meteo から 5 日分の予報を取得し、日本語で整形した結果を返します。

実装上の入力は緯度経度ですが、実際に Codex VS Code Extension から試すときは、必ずしもユーザが緯度経度をそのまま入力する必要はありません。チャットでは「東京駅の天気を教えて」のような自然文で依頼し、必要に応じてツール呼び出し側で座標へ落とし込む形でも確認できます。

全体の流れは次の通りです。

1. forecast API のレスポンス型を定義する
2. API 呼び出し処理を実装する
3. 取得したデータを日本語に整形する
4. MCP のツールとして公開する
5. MCP サーバにツールを登録して起動する
6. Codex VS Code Extension から呼び出して確認する

## ディレクトリ構成

今回の構成は次の通りです。

```text
.
|-- cmd
|   `-- mcp_server
|       `-- main.go
`-- internal
    |-- api
    |   |-- data.go
    |   |-- formetter.go
    |   `-- handler.go
    |-- config
    |   `-- config.go
    |-- server
    |   `-- server.go
    `-- tool
        `-- handler.go
```

役割はざっくり次のように分けています。

- `cmd/mcp_server/main.go`
  - エントリポイント
- `internal/config`
  - 設定値の読み込み
- `internal/api`
  - 外部天気 API の呼び出しとレスポンス定義
- `internal/tool`
  - MCP ツールの処理本体
- `internal/server`
  - MCP サーバ初期化とツール登録

公式チュートリアルでは 1 ファイル寄りでも理解できますが、少しでも育てていく前提なら、このくらい分けておくと追いやすくなります。

## Step 1. API 定義を用意する

最初に、Open-Meteo から返ってくる forecast の受け皿を定義します。

`internal/api/data.go` では、外部 API のレスポンス型と、アプリケーション内部で使う予報 1 件分の型を分けて定義します。

```go
type ForecastResponse struct {
    Latitude  float64 `json:"latitude"`
    Longitude float64 `json:"longitude"`
    Timezone  string  `json:"timezone"`
    Daily     struct {
        Time                        []string  `json:"time"`
        WeatherCode                 []int     `json:"weather_code"`
        Temperature2MMax            []float64 `json:"temperature_2m_max"`
        Temperature2MMin            []float64 `json:"temperature_2m_min"`
        PrecipitationProbabilityMax []int     `json:"precipitation_probability_max"`
        PrecipitationSum            []float64 `json:"precipitation_sum"`
        WindSpeed10MMax             []float64 `json:"wind_speed_10m_max"`
    } `json:"daily"`
}
```

さらに、ツール側で扱いやすいように `ForecastPeriod` も用意します。

```go
type ForecastPeriod struct {
    Date                        string
    WeatherDescription          string
    TemperatureMax              float64
    TemperatureMin              float64
    PrecipitationProbabilityMax int
    PrecipitationSum            float64
    WindSpeedMax                float64
}
```

ここで型を分けておくと、

- Open-Meteo の JSON 形式
- アプリ側で使う意味単位

を切り分けて考えられます。

## Step 2. API 呼び出し処理を実装する

次に、実際に Open-Meteo を呼び出す処理を `internal/api/handler.go` に実装します。

設定値は `internal/config/config.go` で読み込みます。

```go
type Config struct {
    ServerName    string
    ServerVersion string
    APIURL        string
    UserAgent     string
}
```

デフォルト値は次のようにしています。

- `MCP_SERVER_NAME=weather`
- `MCP_SERVER_VERSION=0.1.0`
- `MCP_API_BASE_URL=https://api.open-meteo.com/v1`
- `MCP_USER_AGENT=weather-app/0.1.0`

forecast の取得処理は次のようになります。

```go
func (api *NWSAPI) GetForecast(ctx context.Context, latitude, longitude float64) (*ForecastResponse, error) {
    requestURL := fmt.Sprintf(
        "%s/forecast?latitude=%f&longitude=%f&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&forecast_days=5&timezone=%s",
        strings.TrimRight(api.Config.APIURL, "/"),
        latitude,
        longitude,
        url.QueryEscape("Asia/Tokyo"),
    )

    var result ForecastResponse
    if err := api.doRequest(ctx, requestURL, &result); err != nil {
        return nil, err
    }

    return &result, nil
}
```

ポイントは次の通りです。

- 緯度経度から直接 `forecast` を取得する
- `daily` パラメータで必要な項目だけに絞る
- `forecast_days=5` で 5 日分だけ返す
- `timezone=Asia/Tokyo` を指定して日本時間で扱う

公式チュートリアルとの差分として一番大きいのがここで、米国内前提の `weather.gov` ではなく、日本でもそのまま試しやすい API に差し替えています。

## Step 3. 予報を日本語で整形する

取得した forecast をそのまま返すと、UI 上では少し読みにくくなります。

そこで `internal/api/formetter.go` で、天気コードの日本語化と表示用の整形を行います。

たとえば、天気コードは次のように変換します。

```go
func WeatherCodeDescription(code int) string {
    switch code {
    case 0:
        return "快晴"
    case 1:
        return "おおむね晴れ"
    case 2:
        return "晴れ時々くもり"
    case 3:
        return "くもり"
    case 45, 48:
        return "霧"
    case 51, 53, 55:
        return "霧雨"
    case 61, 63, 65:
        return "雨"
    case 80, 81, 82:
        return "にわか雨"
    default:
        return "不明"
    }
}
```

最終的には次のような文字列を返します。

```text
2026-03-31:
天気: 霧雨
気温: 13.0-18.0°C
降水量: 1.5 mm
降水確率: 45%
最大風速: 17.3 km/h
```

MCP ツールは、そのまま UI に表示されたり、LLM が引用したりすることが多いため、最初のサンプルとしては JSON よりも読みやすいテキスト返却のほうが扱いやすいです。

## Step 4. ツール定義を実装する

次に、MCP の `get_forecast` ツール本体を `internal/tool/handler.go` に実装します。

やることはシンプルで、

1. 緯度経度を受け取る
2. API 層で forecast を取得する
3. 1 日ごとの予報へ詰め直す
4. 文字列として返す

という流れです。

```go
func (h *ToolHandler) GetForecast(ctx context.Context, req *mcp.CallToolRequest, input api.ForecastInput) (*mcp.CallToolResult, any, error) {
    forecastData, err := h.APIHandler.GetForecast(ctx, input.Latitude, input.Longitude)
    if err != nil {
        return h.MCPTextResult([]string{"Unable to fetch forecast data for this location"}), nil, nil
    }

    daily := forecastData.Daily
    periodCount := min(
        len(daily.Time),
        len(daily.WeatherCode),
        len(daily.Temperature2MMax),
        len(daily.Temperature2MMin),
        len(daily.PrecipitationProbabilityMax),
        len(daily.PrecipitationSum),
        len(daily.WindSpeed10MMax),
    )

    var forecasts []string
    for i := range periodCount {
        forecasts = append(forecasts, api.FormatPeriod(api.ForecastPeriod{
            Date:                        daily.Time[i],
            WeatherDescription:          api.WeatherCodeDescription(daily.WeatherCode[i]),
            TemperatureMax:              daily.Temperature2MMax[i],
            TemperatureMin:              daily.Temperature2MMin[i],
            PrecipitationProbabilityMax: daily.PrecipitationProbabilityMax[i],
            PrecipitationSum:            daily.PrecipitationSum[i],
            WindSpeedMax:                daily.WindSpeed10MMax[i],
        }))
    }

    result := strings.Join(forecasts, "\n--\n")
    return h.MCPTextResult([]string{result}), nil, nil
}
```

## Step 5. サーバにツールを登録する

ツールを実装したら、`internal/server/server.go` で MCP サーバへ登録します。

```go
server := mcp.NewServer(
    &mcp.Implementation{
        Name:    s.Config.ServerName,
        Version: s.Config.ServerVersion,
    },
    nil,
)

mcp.AddTool(server,
    &mcp.Tool{
        Name:        "get_forecast",
        Description: "Get weather forecast for a location",
    },
    s.Tools.GetForecast,
)
```

エントリポイントは `cmd/mcp_server/main.go` に分けておきます。

```go
func main() {
    server := server.NewMCPServer()
    server.Run()
}
```

今回のような stdio transport ベースの MCP サーバでは、標準出力は JSON-RPC のやりとりに使われます。デバッグログを安易に標準出力へ出すと通信が壊れるので、必要なら stderr を使うようにします。

## Step 6. 起動確認を行う

まずはローカルで MCP サーバを起動します。

```bash
go run ./cmd/mcp_server
```

起動後、MCP クライアントから接続されると、次のような通知を確認できます。

```text
{"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}
```

この通知が見えれば、少なくとも MCP サーバが起動し、ツール一覧の変更通知を返せる状態になっていると分かります。

## Codex VS Code Extension の設定

Codex VS Code Extension から使う場合は、`~/.codex/config.toml` に MCP サーバ設定を追加します。

```toml
[mcp_servers.weather]
command = "go"
args = ["run", "./cmd/mcp_server"]
cwd = "/path/to/mcp_server"
```

ここでのポイントは次の通りです。

- `command` は `go`
- `args` は `run`, `./cmd/mcp_server`
- `cwd` はこのプロジェクトのルートディレクトリ

今回の記事ではバイナリを事前ビルドせず、`go run ./cmd/mcp_server` で直接起動する形を使っています。この場合、`./cmd/mcp_server` はカレントディレクトリ基準で解決されるため、プロジェクトルートへ移動するための `cwd` が必要です。

つまり、この設定例で `cwd` を入れているのは、Codex VS Code Extension から起動されたときに正しいディレクトリで `go run` できるようにするためです。

一方で、あらかじめバイナリをビルドしておく場合は、`cwd` に依存せず実行できるので、ビルド済みバイナリのパスを `command` に指定する形でも構いません。

たとえば次のような形です。

```toml
[mcp_servers.weather]
command = "/path/to/bin/mcp_server"
args = []
```

まずは試してみたい段階なら `go run + cwd` のほうが手軽で、運用寄りにするならビルド済みバイナリ指定のほうが扱いやすいです。

もし `env` を追加する場合は、コード側の実装と矛盾しない値を入れてください。今回の実装では `MCP_API_BASE_URL` のデフォルトが Open-Meteo なので、過去の `weather.gov` 設定が残っていると取得に失敗します。

`config.toml` を更新したあとは、VS Code 側で MCP サーバを再起動して設定を反映します。

まずは VS Code の設定メニューから MCP の設定画面を開きます。

![VS Code の設定メニューから MCP を開く](/img/202603/11_2_MCP-SettingMenu.png)

次に、`config.toml` に定義したカスタムサーバが一覧に表示され、有効化されていることを確認します。

![MCP のカスタムサーバ一覧で weather サーバが有効になっている状態](/img/202603/11_3_MCP-SettingCustomServer.png)

## Codex VS Code Extension からの動作確認

設定反映後は、Codex VS Code Extension から `weather` MCP サーバの `get_forecast` を呼び出して確認します。

このサーバのツール入力自体は緯度経度ですが、実際には場所の名称でもOKです。たとえば、

```text
東京駅付近の天気予報を教えて
```

のような形式で大丈夫です。
このとき、内部的には指定した場所付近の座標をもとに予報が取得されます。

- 緯度 `35.681236`
- 経度 `139.767125`

返却例は次の通りです。

```text
2026-03-31:
天気: 霧雨
気温: 13.0-18.0°C
降水量: 1.5 mm
降水確率: 45%
最大風速: 17.3 km/h

--

2026-04-01:
天気: 雨
気温: 10.8-18.4°C
降水量: 13.7 mm
降水確率: 90%
最大風速: 8.0 km/h
```

ここまで確認できれば、

- MCP サーバが起動できている
- `get_forecast` ツールが登録されている
- 自然文の依頼からでもツール利用までつながる
- Open-Meteo への API 呼び出しが成功している
- 日本語フォーマットが UI に反映されている

ことを一通り確認できます。

実際のツール実行イメージは次のようになります。

![weather MCP サーバを使って予報を取得した実行結果](/img/202603/11_1_test_output.png)

## まとめ

今回は、MCP 公式の Go チュートリアルをベースにしながら、まず 1 本試せる weather MCP サーバを step by step で作りました。

やったことは次の通りです。

- Open-Meteo 用の API 型を定義した
- API 呼び出し処理を実装した
- 日本語フォーマットを追加した
- `get_forecast` ツールを実装した
- MCP サーバへツール登録した
- Codex VS Code Extension から接続して確認した

公式チュートリアルを読んだあとに、「自分でも 1 回動かしてみたい」という段階なら、今回のように API を日本向けに置き換えたサンプルから入るとかなり試しやすいと思います。
