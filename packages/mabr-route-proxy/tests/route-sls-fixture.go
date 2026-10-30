// Command route-sls-fixture emits a ROUTE SLS object using the multicast
// sender's real SLSPackage.Update implementation. The browser test feeds the
// resulting bytes to route.wasm, so its SLS and manifest assertions exercise
// the same multipart generator used by the sender.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/blockcast/multicast/atsc/models"
	"github.com/blockcast/multicast/common"
	"github.com/blockcast/multicast/flutelib"
	"github.com/blockcast/multicast/route"
)

type fixtureFile struct {
	Location string
	MIME     string
	Path     string
	Body     []byte
}

type fixture struct {
	Body             string   `json:"body"`
	SLT              string   `json:"slt"`
	ManifestLocation []string `json:"manifestLocations"`
	SLSGroup         string   `json:"slsGroup"`
	SLSPort          uint     `json:"slsPort"`
	SLSSource        string   `json:"slsSource"`
	MediaGroup       string   `json:"mediaGroup"`
	MediaPort        uint     `json:"mediaPort"`
	MediaSource      string   `json:"mediaSource"`
}

// rawManifest keeps the HLS playlist bytes in the multipart SLS part. The
// sender's manifest path marshals Manifest.Data.XML; encoding the parsed HLS
// playlist would produce a Go struct-shaped XML document instead of RFC 8216
// text, which route.wasm correctly rejects.
type rawManifest []byte

func (m rawManifest) MarshalXML(encoder *xml.Encoder, _ xml.StartElement) error {
	return encoder.EncodeToken(xml.CharData(m))
}

func hlsSLSBody(body []byte) []byte {
	// SLSPackage.Update serializes Data.XML with encoding/xml, which escapes
	// quotes in HLS attribute lists. Shaka accepts the equivalent unquoted URI
	// form, and it keeps this fixture's wire playlist valid through that API.
	body = bytes.ReplaceAll(body, []byte(`URI="`), []byte(`URI=`))
	body = bytes.ReplaceAll(body, []byte(`.mp4"`), []byte(`.mp4`))
	return body
}

func main() {
	assetsRoot := flag.String("assets", "", "Shaka test asset directory")
	flag.Parse()
	if *assetsRoot == "" {
		panic("-assets is required")
	}

	files := []fixtureFile{
		{Location: "dash/dash.mpd", MIME: "application/dash+xml", Path: filepath.Join(*assetsRoot, "dash-vr", "dash.mpd")},
		{Location: "dash/init.mp4", MIME: "video/mp4", Path: filepath.Join(*assetsRoot, "dash-vr", "init.mp4")},
		{Location: "dash/segment_0.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_0.m4s")},
		{Location: "dash/segment_1.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_1.m4s")},
		{Location: "dash/segment_2.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_2.m4s")},
		{Location: "dash/segment_3.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_3.m4s")},
		{Location: "dash/segment_4.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_4.m4s")},
		{Location: "dash/segment_5.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "dash-vr", "segment_5.m4s")},
		{Location: "hls/master.m3u8", MIME: "application/vnd.apple.mpegurl", Body: []byte("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n")},
		{Location: "hls/media.m3u8", MIME: "application/vnd.apple.mpegurl", Path: filepath.Join(*assetsRoot, "hls-mp4-muxed-aac-h264", "hls.m3u8")},
		{Location: "hls/init.mp4", MIME: "video/mp4", Path: filepath.Join(*assetsRoot, "hls-mp4-muxed-aac-h264", "init.mp4")},
		{Location: "hls/hls11.m4s", MIME: "video/iso.segment", Path: filepath.Join(*assetsRoot, "hls-mp4-muxed-aac-h264", "hls11.m4s")},
	}
	bodies := make(map[string][]byte, len(files))
	for _, file := range files {
		body := file.Body
		if body == nil {
			var err error
			body, err = os.ReadFile(file.Path)
			if err != nil {
				panic(fmt.Errorf("read %s: %w", file.Path, err))
			}
		}
		bodies[file.Location] = body
	}

	const (
		slsGroup    = "239.21.4.1"
		slsPort     = 5004
		slsSource   = "192.0.2.10"
		mediaGroup  = "239.21.4.2"
		mediaPort   = 5005
		mediaSource = "192.0.2.11"
	)
	fdt, err := flutelib.NewFDT(
		mediaSource+","+mediaGroup+",5005", 1, 1, nil,
		1, 65535, 65535, 1, true,
	)
	if err != nil {
		panic(fmt.Errorf("create embedded FDT: %w", err))
	}
	for index, file := range files {
		entry, err := flutelib.NewFile(
			mediaSource+","+mediaGroup+",5005", nil, nil,
			0, uint64(index+1), 1,
		)
		if err != nil {
			panic(fmt.Errorf("create FDT entry %s: %w", file.Location, err))
		}
		entry.ContentLocation = file.Location
		entry.ContentType = file.MIME
		entry.TransferLength = uint64(len(bodies[file.Location]))
		if err := fdt.AddFile(entry); err != nil {
			panic(fmt.Errorf("add FDT entry %s: %w", file.Location, err))
		}
	}

	stsid := &models.STSIDType{RS: []models.RSessionType{{
		SIpAddr: models.IPv4addressType(mediaSource),
		DIpAddr: models.IPv4addressType(mediaGroup),
		DPort:   mediaPort,
		LS: []models.LSessionType{{
			Tsi: 1,
			SrcFlow: &models.SrcFlowType{
				EFDT: &models.EFDTType{FDTInstance: fdt},
				ContentInfo: &models.ContentInfoType{MediaInfo: &models.MediaInfoType{
					ContentType: "video/mp4",
					RepId:       "nasa-iss-a",
				}},
				Payload: []models.PayloadType{{CodePoint: 8, FormatId: 1, SrcFecPayloadId: 0}},
			},
		}},
	}}}

	parsedMPD, err := common.ParseManifest("dash/dash.mpd", bodies["dash/dash.mpd"])
	if err != nil {
		panic(fmt.Errorf("parse DASH manifest: %w", err))
	}
	manifests := []*route.Manifest{
		{MIME: "application/dash+xml", URL: "dash/dash.mpd", Data: parsedMPD},
		{MIME: "application/vnd.apple.mpegurl", URL: "hls/master.m3u8", Data: common.Manifest{XML: rawManifest(hlsSLSBody(bodies["hls/master.m3u8"]))}},
		{MIME: "application/vnd.apple.mpegurl", URL: "hls/media.m3u8", Data: common.Manifest{XML: rawManifest(hlsSLSBody(bodies["hls/media.m3u8"]))}},
	}
	sender, err := route.NewSLSPackageSender(1<<20, 1<<20, 1, 1<<20, nil, false, 0, nil)
	if err != nil {
		panic(fmt.Errorf("create SLS sender: %w", err))
	}
	body, err := sender.Update(stsid, nil, manifests, nil, nil)
	if err != nil {
		panic(fmt.Errorf("generate SLS bundle: %w", err))
	}

	// The DS /slt/<group> document, encoded as the sender's generateSltXML
	// does, with the TO-selected manifest path the derived e2e pass loads.
	var slt bytes.Buffer
	sltEncoder := xml.NewEncoder(&slt)
	sltEncoder.Indent("", "\t")
	if err := sltEncoder.Encode(&models.SltType{
		Bsid: models.ListOfUnsignedShortType{7},
		Service: []models.ServiceType{{
			ServiceId:       42,
			GlobalServiceID: "nasa-iss-a",
			SltSvcSeqNum:    1,
			ServiceCategory: 1,
			BroadcastSvcSignaling: models.BroadcastSigType{
				SlsProtocol:             1,
				SlsDestinationIpAddress: models.IPv4addressType(slsGroup),
				SlsDestinationUdpPort:   slsPort,
				SlsSourceIpAddress:      models.IPv4addressType(slsSource),
			},
			PresentationManifest: []models.PresentationManifestType{{Value: "/dash/dash.mpd", ManifestID: "dash"}},
		}},
	}); err != nil {
		panic(fmt.Errorf("generate SLT: %w", err))
	}

	if err := json.NewEncoder(os.Stdout).Encode(fixture{
		Body:             base64.StdEncoding.EncodeToString(body),
		SLT:              slt.String(),
		ManifestLocation: []string{"dash/dash.mpd", "hls/master.m3u8", "hls/media.m3u8"},
		SLSGroup:         slsGroup,
		SLSPort:          slsPort,
		SLSSource:        slsSource,
		MediaGroup:       mediaGroup,
		MediaPort:        mediaPort,
		MediaSource:      mediaSource,
	}); err != nil {
		panic(err)
	}
}
