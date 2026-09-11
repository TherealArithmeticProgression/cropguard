import math

def calculate_rice_blast_risk(input_details: dict) -> dict:
    """
    Calculates a zero-history, scientifically defensible Rice Blast risk score (0-100%)
    using a static points-based scorecard.
    
    Weights are derived from peer-reviewed sensitivity analyses of TNAU Coimbatore 
    (Meena AG et al., 2024) and variety studies from coastal South-Eastern India (Pattanayak & Das, 2020).
    """
    # 1. Initialize Points (Max 100 Points)
    score_details = {
        "solar_radiation_points": 0.0,
        "rh_morning_points": 0.0,
        "temp_min_points": 0.0,
        "leaf_wetness_points": 0.0
    }
    
    # Extract absolute sensor/API values with default conservative values
    solar_rad = input_details.get("solar_radiation", 330.0)
    rh_morning = input_details.get("rh_morning", 85.0)
    temp_min = input_details.get("temp_min", 22.0)
    leaf_wetness = input_details.get("leaf_wetness_hours", 6.0)
    cultivar_resistance = input_details.get("cultivar_resistance", "medium")
    
    # --- Solar Radiation (Max 30 Pts) ---
    # Coimbatore Sobol sensitivity analysis proved Solar Radiation accounts for 
    # 78.03% of direct variance in disease. UV rays damage spores. Low radiation triggers risk.
    if solar_rad < 250.0:
        score_details["solar_radiation_points"] = 30.0
    elif solar_rad < 300.0:
        score_details["solar_radiation_points"] = 25.0
    elif solar_rad < 350.0:
        score_details["solar_radiation_points"] = 15.0
    else:
        score_details["solar_radiation_points"] = 0.0
        
    # --- Morning Humidity (Max 30 Pts) ---
    # The Coimbatore study's peak infection coincided with a mean morning humidity of 86.21%.
    if rh_morning >= 90.0:
        score_details["rh_morning_points"] = 30.0
    elif rh_morning >= 85.0:
        score_details["rh_morning_points"] = 25.0
    elif rh_morning >= 75.0:
        score_details["rh_morning_points"] = 15.0
    else:
        score_details["rh_morning_points"] = 0.0
        
    # --- Minimum Temperature (Max 25 Pts) ---
    # Pathogen mycelial growth thrives optimally between 20°C and 28°C.
    if 20.0 <= temp_min <= 28.0:
        score_details["temp_min_points"] = 25.0
    elif 17.0 <= temp_min < 20.0 or 28.0 < temp_min <= 31.0:
        score_details["temp_min_points"] = 15.0
    else:
        score_details["temp_min_points"] = 0.0
        
    # --- Leaf Wetness (Max 15 Pts) ---
    # Sustained dew duration allows spore attachment. Coimbatore mean during peaks was 5.99 hours.
    if leaf_wetness >= 8.0:
        score_details["leaf_wetness_points"] = 15.0
    elif leaf_wetness >= 5.9:
        score_details["leaf_wetness_points"] = 10.0
    elif leaf_wetness >= 3.0:
        score_details["leaf_wetness_points"] = 5.0
    else:
        score_details["leaf_wetness_points"] = 0.0

    raw_points_sum = sum(score_details.values())
    
    # Apply Multiplicative Variety Adjuster (Coastal South-Eastern India study)
    # Susceptible Samba Mahsuri/Pooja amplify risk; resistant Swarna divides it.
    cultivar_lower = cultivar_resistance.lower()
    if cultivar_lower in ["susceptible", "low"]:
        variety_multiplier = 1.3
        variety_note = "Amplified (+30%) due to high cultivar susceptibility (Pooja/Samba Mahsuri profile)."
    elif cultivar_lower in ["resistant", "high", "tolerant"]:
        variety_multiplier = 0.5
        variety_note = "Suppressed (-50%) due to robust cultivar tolerance (Swarna profile)."
    else:
        variety_multiplier = 1.0
        variety_note = "Neutral baseline cultivar multiplier applied."
        
    final_risk_score = raw_points_sum * variety_multiplier
    final_risk_score = max(0.0, min(final_risk_score, 100.0))
    
    if final_risk_score < 35.0:
        band = "LOW"
        advisory = "Environmental conditions are stable. Continue baseline weekly observations."
    elif final_risk_score < 70.0:
        band = "MEDIUM"
        advisory = "Favorable microclimate detected! Spore incubation conditions are emerging. Increase monitoring frequency."
    else:
        band = "HIGH"
        advisory = ("CRITICAL BLAST RISK! Environmental parameters have aligned for high spore colonization. "
                    "Prophylactic fungicide spray (e.g., Tricyclazole 75% WP or Isoprothiolane 40% EC) is recommended.")
        
    return {
        "disease": "Rice Blast",
        "risk_score": round(final_risk_score, 1),
        "risk_band": band,
        "cultivar_multiplier": variety_multiplier,
        "cultivar_notes": variety_note,
        "scorecard_breakdown": score_details,
        "agronomic_advisory": advisory
    }

def calculate_bacterial_leaf_blight_risk(input_details: dict) -> dict:
    """
    Calculates a zero-history, points-based Bacterial Leaf Blight (BLB) risk score (0-100%).

    Weights and thresholds are derived from Raichur Karnataka studies (Suresh et al., 2013)
    and Punjab studies (Sharma & Thind, 2007).
    """
    score_details = {
        "average_temp_points": 0.0,
        "rh_morning_points": 0.0,
        "wounding_points": 0.0,
        "nitrogen_fertilizer_points": 0.0
    }

    temp_max = input_details.get("temp_max", 30.0)
    temp_min = input_details.get("temp_min", 22.0)
    rh_morning = input_details.get("rh_morning", 85.0)
    rainfall = input_details.get("rainfall", 0.0)
    wind_speed = input_details.get("wind_speed", 5.0)
    nitrogen_applied = input_details.get("nitrogen_applied_kg_ha", 100.0)
    cultivar_resistance = input_details.get("cultivar_resistance", "medium")

    # --- 1. Average Temperature (Max 30 Pts) ---
    # Xanthomonas oryzae pv. oryzae thrives in warm conditions (25-30°C optimal).
    avg_temp = (temp_max + temp_min) / 2.0
    if 25.0 <= avg_temp <= 30.0:
        score_details["average_temp_points"] = 30.0
    elif 20.0 <= avg_temp < 25.0 or 30.0 < avg_temp <= 35.0:
        score_details["average_temp_points"] = 15.0
    else:
        score_details["average_temp_points"] = 0.0

    # --- 2. Morning Humidity (Max 30 Pts) ---
    # High morning relative humidity (>80%) triggers bacterial ooze release and splash dispersal.
    if rh_morning >= 90.0:
        score_details["rh_morning_points"] = 30.0
    elif rh_morning >= 80.0:
        score_details["rh_morning_points"] = 20.0
    elif rh_morning >= 70.0:
        score_details["rh_morning_points"] = 10.0
    else:
        score_details["rh_morning_points"] = 0.0

    # --- 3. Wounding and Splashing Conditions (Max 20 Pts) ---
    # High wind rubs leaf blades together creating micro-wounds/entry gateways. Heavy rain splashes inoculum.
    if wind_speed > 10.0 or rainfall > 50.0:
        score_details["wounding_points"] = 20.0
    elif wind_speed > 5.0 or rainfall > 10.0:
        score_details["wounding_points"] = 10.0
    else:
        score_details["wounding_points"] = 0.0

    # --- 4. Nitrogen / Urea Over-Fertilization (Max 20 Pts) ---
    # Excess Nitrogen softens vegetative plant tissue, lowering physiological defenses against bacteria.
    if nitrogen_applied > 120.0:
        score_details["nitrogen_fertilizer_points"] = 20.0
    elif nitrogen_applied >= 80.0:
        score_details["nitrogen_fertilizer_points"] = 10.0
    else:
        score_details["nitrogen_fertilizer_points"] = 0.0

    raw_points_sum = sum(score_details.values())

    # Apply Multiplicative Variety Adjuster
    # Samba Mahsuri (BPT-5204) is highly susceptible to BLB; resistant lines divide it.
    cultivar_lower = cultivar_resistance.lower()
    if cultivar_lower in ["susceptible", "low"]:
        variety_multiplier = 1.3
        variety_note = "Amplified (+30%) due to high cultivar susceptibility (BPT-5204/Samba Mahsuri profile)."
    elif cultivar_lower in ["resistant", "high", "tolerant"]:
        variety_multiplier = 0.5
        variety_note = "Suppressed (-50%) due to robust cultivar tolerance."
    else:
        variety_multiplier = 1.0
        variety_note = "Neutral baseline cultivar multiplier applied."

    final_risk_score = raw_points_sum * variety_multiplier
    final_risk_score = max(0.0, min(final_risk_score, 100.0))

    if final_risk_score < 35.0:
        band = "LOW"
        advisory = "BLB environmental triggers are low. Maintain standard crop monitoring and fertilizer logs."
    elif final_risk_score < 70.0:
        band = "MEDIUM"
        advisory = "Congenial warm and humid parameters detected. Avoid excessive nitrogenous/urea top dressing."
    else:
        band = "HIGH"
        advisory = ("HIGH BLB EPIDEMIC RISK! High temp, moisture, and wounding conditions have aligned. "
                    "If bacterial leaf lesions appear, spray Agrimycin or Streptocycline combined with Copper Oxychloride immediately.")

    return {
        "disease": "Bacterial Leaf Blight",
        "risk_score": round(final_risk_score, 1),
        "risk_band": band,
        "cultivar_multiplier": variety_multiplier,
        "cultivar_notes": variety_note,
        "scorecard_breakdown": score_details,
        "agronomic_advisory": advisory
    }

def calculate_tomato_leaf_curl_risk(input_details: dict) -> dict:
    """
    Calculates Tomato Leaf Curl Virus (ToLCV) risk (0-100%) using the peer-reviewed
    Beta Regression Model from West Bengal (Gurung et al., 2022).
    """
    temp_max = input_details.get("temp_max", 30.0)
    temp_min = input_details.get("temp_min", 22.0)
    rh_morning = input_details.get("rh_morning", 85.0)
    rh_evening = input_details.get("rh_evening", 60.0)
    rainfall = input_details.get("rainfall", 0.0)
    sunshine = input_details.get("sunshine_hours", 6.0)
    wind_speed = input_details.get("wind_speed", 5.0)
    
    rh_mean = input_details.get("rh_mean")
    if rh_mean is None:
        rh_mean = (rh_morning + rh_evening) / 2.0
        
    # Gurung et al. West Bengal Beta Regression coefficients (logit link)
    # g(mu) = -0.168 + 0.025*Tmax - 0.134*Tmin - 0.008*RHmean + 0.018*Rainfall + 0.014*Sunshine - 0.033*Wind
    logit_g = (-0.168 
               + 0.025 * temp_max 
               - 0.134 * temp_min 
               - 0.008 * rh_mean 
               + 0.018 * rainfall 
               + 0.014 * sunshine 
               - 0.033 * wind_speed)
    
    # Logit link inverse: mu = e^g / (1 + e^g)
    try:
        mu_infected = math.exp(logit_g) / (1.0 + math.exp(logit_g))
    except OverflowError:
        mu_infected = 1.0 if logit_g > 0 else 0.0
        
    final_risk_score = mu_infected * 100.0
    final_risk_score = max(0.0, min(final_risk_score, 100.0))
    
    if final_risk_score < 35.0:
        band = "LOW"
        advisory = "Vector activity and virus replication risk are low. Continue standard field practices."
    elif final_risk_score < 70.0:
        band = "MEDIUM"
        advisory = "Moderate conditions favoring whitefly (Bemisia tabaci) replication. Monitor vector density closely."
    else:
        band = "HIGH"
        advisory = ("HIGH CURL RISK! Warm days, cool nights, and high sunshine have stimulated whitefly vectors. "
                    "Imidacloprid or yellow sticky trap deployment is highly recommended to prevent virus spread.")
        
    return {
        "disease": "Tomato Leaf Curl",
        "risk_score": round(final_risk_score, 1),
        "risk_band": band,
        "calculated_logit_g": round(logit_g, 4),
        "agronomic_advisory": advisory
    }


def calculate_risk_score(disease: str, input_details: dict) -> dict:
    """
    Master API Function to route weather input payloads to specific zero-history disease modules.
    
    Parameters:
    - disease (str): One of "rice_blast", "tomato_leaf_curl", "bacterial_leaf_blight"
    - input_details (dict): Payload containing weather and management parameters.
    
    Returns:
    - dict: Formatted RiskResult payload.
    """
    disease_lower = disease.lower().replace(" ", "_")
    
    if disease_lower in ["rice_blast", "blast"]:
        return calculate_rice_blast_risk(input_details)
    elif disease_lower in ["tomato_leaf_curl", "tomato_curl", "leaf_curl"]:
        return calculate_tomato_leaf_curl_risk(input_details)
    elif disease_lower in ["bacterial_leaf_blight", "leaf_blight", "blb"]:
        return calculate_bacterial_leaf_blight_risk(input_details)
    else:
        raise ValueError(f"Unknown disease type: '{disease}'. Valid types: 'rice_blast', 'tomato_leaf_curl', 'bacterial_leaf_blight'")
