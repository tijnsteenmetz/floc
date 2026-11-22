import Foundation
import CoreLocation
import Combine

enum LocationMode: String, CaseIterable, Identifiable {
    case joystick = "Joystick"
    case gps = "GPS"
    var id: String { rawValue }
}

enum CameraMode {
    case northUp, headingUp
}

/// Holds the raw location (GPS or joystick), the interpreted location (the dot) and camera state.
final class LocationModel: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var mode: LocationMode = .joystick { didSet { modeChanged() } }
    /// What the "sensor" says: real GPS or the joystick position.
    @Published private(set) var raw: CLLocationCoordinate2D?
    /// Where the app thinks you are. Everything else uses this.
    @Published private(set) var dot: CLLocationCoordinate2D?
    /// Degrees clockwise from north.
    @Published private(set) var heading: Double = 0
    @Published private(set) var accuracy: Double?

    @Published var showRaw = false
    @Published var cameraMode: CameraMode = .northUp
    @Published var following = true

    /// Current map rotation (degrees), so the joystick's "up" is always screen-up.
    var mapBearing: Double = 0

    private let interpreter: LocationInterpreter
    var projection: LocalProjection { interpreter.projection.proj }
    private let manager = CLLocationManager()

    // Joystick
    private var stick = SIMD2<Double>(0, 0)   // x right, y up, each −1…1
    private var timer: Timer?
    private var lastTick = Date()
    static let walkingSpeed = 5.0 / 3.6     // m/s
    static let turnRate = 120.0             // degrees/s at full stick (heading-up mode)

    init(map: EventMap) {
        interpreter = LocationInterpreter(map: map)
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.headingFilter = 2
    }

    deinit { stop() }

    func stop() {
        timer?.invalidate(); timer = nil
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    // MARK: - Joystick

    /// Tap on the map in joystick mode: put yourself there.
    func place(at c: CLLocationCoordinate2D) {
        guard mode == .joystick else { return }
        setRaw(c)
        following = true
    }

    /// Joystick deflection; (0,0) when released.
    func setStick(_ v: SIMD2<Double>) {
        stick = v
        if v == .zero {
            timer?.invalidate(); timer = nil
        } else if timer == nil {
            lastTick = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        }
    }

    private func tick() {
        let now = Date()
        let dt = now.timeIntervalSince(lastTick)
        lastTick = now
        guard let r = raw else { return }
        let magnitude = min(1, (stick * stick).sum().squareRoot())
        guard magnitude > 0.05 else { return }

        var bearingDeg: Double
        var metres: Double
        if cameraMode == .headingUp && following {
            // Game-style: left/right turns, up/down walks forward/back.
            bearingDeg = heading + stick.x * Self.turnRate * dt
            metres = Self.walkingSpeed * stick.y * dt
        } else {
            // Push the stick where you want to go on screen (accounting for map rotation).
            let screenAngle = atan2(stick.x, stick.y) * 180 / .pi   // clockwise from screen-up
            bearingDeg = screenAngle + mapBearing
            metres = Self.walkingSpeed * magnitude * dt
        }
        bearingDeg = bearingDeg.truncatingRemainder(dividingBy: 360)
        if bearingDeg < 0 { bearingDeg += 360 }
        heading = bearingDeg

        let b = bearingDeg * .pi / 180
        let dLat = cos(b) * metres / 110_540
        let dLon = sin(b) * metres / (111_320 * cos(r.latitude * .pi / 180))
        setRaw(CLLocationCoordinate2D(latitude: r.latitude + dLat, longitude: r.longitude + dLon))
    }

    // MARK: - GPS

    private func modeChanged() {
        setStick(.zero)
        switch mode {
        case .gps:
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
            manager.startUpdatingLocation()
            manager.startUpdatingHeading()
            following = true
        case .joystick:
            manager.stopUpdatingLocation()
            manager.stopUpdatingHeading()
            raw = nil; dot = nil; accuracy = nil   // tap the map to place yourself
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard mode == .gps, let loc = locations.last else { return }
        accuracy = loc.horizontalAccuracy
        setRaw(loc.coordinate)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading h: CLHeading) {
        guard mode == .gps else { return }
        heading = h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if mode == .gps { manager.startUpdatingLocation() }
    }

    // MARK: -

    private func setRaw(_ c: CLLocationCoordinate2D) {
        raw = c
        dot = interpreter.interpret(c)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-logLocation"), let d = dot {
            NSLog("LOC raw=\(c.latitude),\(c.longitude) dot=\(d.latitude),\(d.longitude)")
        }
        #endif
    }
}
